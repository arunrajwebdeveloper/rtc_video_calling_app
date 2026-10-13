import React, { useEffect, useRef, useState } from "react";
import io from "socket.io-client";

const serverURL =
  import.meta.env.VITE_SOCKET_SERVER_URL || "http://localhost:5656";

const configuration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

export default function App() {
  const [inRoom, setInRoom] = useState(false);
  const [roomID, setRoomID] = useState("");
  const [inputRoom, setInputRoom] = useState("");

  // Call States: 'IDLE' | 'CALLING' | 'RECEIVED_CALL' | 'CONNECTED'
  const [callStatus, setCallStatus] = useState("IDLE");
  const [partnerID, setPartnerID] = useState(null);
  const [incomingOffer, setIncomingOffer] = useState(null);

  const socketRef = useRef();
  const userVideo = useRef();
  const partnerVideo = useRef();
  const peerConnection = useRef();
  const localStream = useRef();
  const iceCandidatesQueue = useRef([]);

  useEffect(() => {
    socketRef.current = io(serverURL);

    socketRef.current.on("connect", () => {
      console.log("Connected to server:", socketRef.current.id);
    });

    socketRef.current.on("room-users", (users) => {
      if (users.length > 0) {
        setPartnerID(users[0]);
        console.log("Partner found in room:", users[0]);
      }
    });

    socketRef.current.on("user-joined", (id) => {
      setPartnerID(id);
      console.log("New partner joined:", id);
    });

    socketRef.current.on("incoming-call", async ({ offer, caller }) => {
      console.log("Incoming call from:", caller);
      setPartnerID(caller);
      setIncomingOffer(offer);
      setCallStatus("RECEIVED_CALL");
    });

    socketRef.current.on("call-accepted", async ({ answer }) => {
      console.log("Call accepted by partner");
      if (peerConnection.current) {
        await peerConnection.current.setRemoteDescription(
          new RTCSessionDescription(answer),
        );
        while (iceCandidatesQueue.current.length > 0) {
          const candidate = iceCandidatesQueue.current.shift();
          await peerConnection.current.addIceCandidate(
            new RTCIceCandidate(candidate),
          );
        }
      }
      setCallStatus("CONNECTED");
    });

    socketRef.current.on("call-rejected", () => {
      alert("Call was rejected by partner.");
      cleanupCall();
    });

    socketRef.current.on("call-cancelled", () => {
      alert("Partner cancelled the call.");
      setCallStatus("IDLE");
      setIncomingOffer(null);
    });

    socketRef.current.on("ice-candidate", async ({ candidate }) => {
      if (candidate) {
        try {
          const pc = peerConnection.current;
          if (pc && pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } else {
            iceCandidatesQueue.current.push(candidate);
          }
        } catch (e) {
          console.error("Error adding received ice candidate", e);
        }
      }
    });

    socketRef.current.on("hang-up", () => {
      alert("Partner ended the call.");
      cleanupCall();
    });

    socketRef.current.on("user-disconnected", () => {
      alert("Partner disconnected.");
      cleanupCall();
    });

    return () => {
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, []);

  async function joinRoom() {
    if (!inputRoom.trim()) {
      alert("Please enter a room name");
      return;
    }
    setRoomID(inputRoom);
    setInRoom(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      localStream.current = stream;
      if (userVideo.current) {
        userVideo.current.srcObject = stream;
      }
      socketRef.current.emit("join-room", inputRoom);
    } catch (err) {
      console.error("Error accessing media devices.", err);
      alert("Could not access camera or microphone.");
      setInRoom(false);
    }
  }

  function createPeerConnection(targetID) {
    if (peerConnection.current) {
      peerConnection.current.close();
    }

    const pc = new RTCPeerConnection(configuration);
    peerConnection.current = pc;

    pc.oniceconnectionstatechange = () => {
      console.log("ICE Connection State:", pc.iceConnectionState);
    };

    if (localStream.current) {
      localStream.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStream.current);
      });
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current.emit("ice-candidate", {
          target: targetID,
          candidate: event.candidate,
        });
      }
    };

    pc.ontrack = (event) => {
      console.log("--> SUCCESS: Received remote video track!");
      if (partnerVideo.current) {
        partnerVideo.current.srcObject = event.streams[0];
        partnerVideo.current
          .play()
          .catch((err) => console.log("Autoplay error:", err));
      }
    };

    return pc;
  }

  // Action: User A starts a call
  async function startCall() {
    if (!partnerID) {
      alert("No partner in the room yet. Wait for someone to join!");
      return;
    }
    setCallStatus("CALLING");
    const pc = createPeerConnection(partnerID);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socketRef.current.emit("call-user", { offer, target: partnerID });
  }

  // Action: User A cancels outbound call
  function cancelCall() {
    if (partnerID) {
      socketRef.current.emit("cancel-call", { target: partnerID });
    }
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }
    setCallStatus("IDLE");
  }

  // Action: User B accepts incoming call
  async function acceptCall() {
    setCallStatus("CONNECTED");
    const pc = createPeerConnection(partnerID);
    await pc.setRemoteDescription(new RTCSessionDescription(incomingOffer));

    while (iceCandidatesQueue.current.length > 0) {
      const candidate = iceCandidatesQueue.current.shift();
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socketRef.current.emit("accept-call", { answer, target: partnerID });
  }

  // Action: User B rejects incoming call
  function rejectCall() {
    if (partnerID) {
      socketRef.current.emit("reject-call", { target: partnerID });
    }
    setCallStatus("IDLE");
    setIncomingOffer(null);
  }

  // Action: Either user ends active call or hangs up
  function endCall() {
    if (partnerID) {
      socketRef.current.emit("hang-up", { target: partnerID });
    }
    cleanupCall();
  }

  function cleanupCall() {
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }
    if (partnerVideo.current) {
      partnerVideo.current.srcObject = null;
    }
    iceCandidatesQueue.current = [];
    setCallStatus("IDLE");
    setIncomingOffer(null);
  }

  return (
    <div
      style={{
        padding: "2rem",
        maxWidth: "900px",
        margin: "0 auto",
        textAlign: "center",
      }}
    >
      <h1 style={{ marginBottom: "1.5rem" }}>React WebRTC Video Call</h1>

      {!inRoom ? (
        <div
          style={{
            background: "#1e293b",
            padding: "2rem",
            borderRadius: "8px",
            boxShadow: "0 4px 6px rgba(0,0,0,0.3)",
          }}
        >
          <input
            type="text"
            placeholder="Enter Room ID (e.g. room123)"
            value={inputRoom}
            onChange={(e) => setInputRoom(e.target.value)}
            style={{
              padding: "0.75rem 1rem",
              fontSize: "1rem",
              borderRadius: "4px",
              border: "1px solid #475569",
              background: "#0f172a",
              color: "#fff",
              width: "60%",
              marginRight: "1rem",
            }}
          />
          <button
            onClick={joinRoom}
            style={{
              padding: "0.75rem 1.5rem",
              fontSize: "1rem",
              fontWeight: "bold",
              background: "#2563eb",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Join Room
          </button>
        </div>
      ) : (
        <div>
          <p
            style={{
              fontSize: "1.1rem",
              marginBottom: "1rem",
              color: "#38bdf8",
            }}
          >
            Connected to Room: <strong>{roomID}</strong> | Partner Status:{" "}
            <span style={{ color: partnerID ? "#4ade80" : "#f87171" }}>
              {partnerID ? "Partner Available" : "Waiting for partner..."}
            </span>
          </p>

          {/* Call Control Action Bar */}
          <div style={{ marginBottom: "1.5rem" }}>
            {callStatus === "IDLE" && (
              <button
                onClick={startCall}
                disabled={!partnerID}
                style={{
                  padding: "0.75rem 2rem",
                  fontSize: "1rem",
                  fontWeight: "bold",
                  background: partnerID ? "#16a34a" : "#64748b",
                  color: "#fff",
                  border: "none",
                  borderRadius: "6px",
                  cursor: partnerID ? "pointer" : "not-allowed",
                }}
              >
                📞 Call Partner
              </button>
            )}

            {callStatus === "CALLING" && (
              <div>
                <p style={{ color: "#fbbf24", marginBottom: "0.5rem" }}>
                  Calling partner, ringing...
                </p>
                <button
                  onClick={cancelCall}
                  style={{
                    padding: "0.75rem 2rem",
                    fontSize: "1rem",
                    fontWeight: "bold",
                    background: "#dc2626",
                    color: "#fff",
                    border: "none",
                    borderRadius: "6px",
                    cursor: "pointer",
                  }}
                >
                  ❌ Cancel
                </button>
              </div>
            )}

            {callStatus === "RECEIVED_CALL" && (
              <div
                style={{
                  background: "#334155",
                  padding: "1rem",
                  borderRadius: "8px",
                  display: "inline-block",
                }}
              >
                <p
                  style={{
                    color: "#38bdf8",
                    marginBottom: "0.75rem",
                    fontWeight: "bold",
                  }}
                >
                  Incoming Video Call...
                </p>
                <div style={{ display: "flex", gap: "1rem" }}>
                  <button
                    onClick={acceptCall}
                    style={{
                      padding: "0.5rem 1.5rem",
                      fontSize: "1rem",
                      fontWeight: "bold",
                      background: "#16a34a",
                      color: "#fff",
                      border: "none",
                      borderRadius: "6px",
                      cursor: "pointer",
                    }}
                  >
                    ✔️ Pick Up
                  </button>
                  <button
                    onClick={rejectCall}
                    style={{
                      padding: "0.5rem 1.5rem",
                      fontSize: "1rem",
                      fontWeight: "bold",
                      background: "#dc2626",
                      color: "#fff",
                      border: "none",
                      borderRadius: "6px",
                      cursor: "pointer",
                    }}
                  >
                    ❌ Reject
                  </button>
                </div>
              </div>
            )}

            {callStatus === "CONNECTED" && (
              <button
                onClick={endCall}
                style={{
                  padding: "0.75rem 2rem",
                  fontSize: "1rem",
                  fontWeight: "bold",
                  background: "#dc2626",
                  color: "#fff",
                  border: "none",
                  borderRadius: "6px",
                  cursor: "pointer",
                }}
              >
                🔴 End Call
              </button>
            )}
          </div>

          {/* Video Feeds */}
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              gap: "2rem",
              flexWrap: "wrap",
            }}
          >
            <div
              style={{
                background: "#1e293b",
                padding: "1rem",
                borderRadius: "8px",
              }}
            >
              <p style={{ margin: "0 0 0.5rem 0", fontWeight: "bold" }}>
                You (Local)
              </p>
              <video
                ref={userVideo}
                autoPlay
                muted
                playsInline
                style={{
                  width: "350px",
                  height: "260px",
                  background: "#000",
                  borderRadius: "4px",
                  objectFit: "cover",
                }}
              />
            </div>
            <div
              style={{
                background: "#1e293b",
                padding: "1rem",
                borderRadius: "8px",
              }}
            >
              <p style={{ margin: "0 0 0.5rem 0", fontWeight: "bold" }}>
                Partner (Remote)
              </p>
              <video
                ref={partnerVideo}
                autoPlay
                playsInline
                style={{
                  width: "350px",
                  height: "260px",
                  background: "#000",
                  borderRadius: "4px",
                  objectFit: "cover",
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
