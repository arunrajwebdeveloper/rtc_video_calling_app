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

  const [incomingCall, setIncomingCall] = useState(null); // { payload, caller }
  const [callAccepted, setCallAccepted] = useState(false);

  // Local mute states
  const [micMuted, setMicMuted] = useState(false);
  const [camMuted, setCamMuted] = useState(false);

  // Remote mute states (from partner)
  const [remoteCamMuted, setRemoteCamMuted] = useState(false);
  const [remoteMicMuted, setRemoteMicMuted] = useState(false);

  const [partnerID, setPartnerID] = useState(null);

  const socketRef = useRef();
  const userVideo = useRef();
  const partnerVideo = useRef();
  const peerConnection = useRef();
  const localStream = useRef();
  const iceCandidateQueue = useRef([]); // Queue ICE candidates arriving before remote description

  useEffect(() => {
    socketRef.current = io(serverURL);

    // Triggered when you join a room and someone is already inside
    socketRef.current.on("other-user", (id) => {
      setPartnerID(id);
    });

    // Triggered when another user joins the room after you
    socketRef.current.on("user-joined", (id) => {
      setPartnerID(id);
    });

    // When an offer arrives from partner, show Attend / Reject UI
    socketRef.current.on("offer", async ({ payload, caller }) => {
      setPartnerID(caller);
      setIncomingCall({ payload, caller });
    });

    socketRef.current.on("answer", async ({ payload }) => {
      if (peerConnection.current) {
        await peerConnection.current.setRemoteDescription(
          new RTCSessionDescription(payload),
        );
        processQueuedIceCandidates();
        setCallAccepted(true);
      }
    });

    socketRef.current.on("ice-candidate", async ({ candidate }) => {
      if (candidate) {
        const pc = peerConnection.current;
        if (pc && pc.remoteDescription && pc.remoteDescription.type) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e) {
            console.error("Error adding received ice candidate", e);
          }
        } else {
          iceCandidateQueue.current.push(candidate);
        }
      }
    });

    // Listen for partner's mic/cam toggle events
    socketRef.current.on("media-toggle", ({ type, muted }) => {
      if (type === "video") setRemoteCamMuted(muted);
      if (type === "audio") setRemoteMicMuted(muted);
    });

    socketRef.current.on("call-rejected", () => {
      cleanupCall();
      alert("Call was rejected by partner.");
    });

    socketRef.current.on("user-disconnected", () => {
      cleanupCall();
      alert("Partner disconnected.");
    });

    return () => {
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, []);

  async function startCall() {
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
    const pc = new RTCPeerConnection(configuration);
    peerConnection.current = pc;

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
      if (partnerVideo.current) {
        partnerVideo.current.srcObject = event.streams[0];
      }
    };

    return pc;
  }

  // Call partner manually once they are in the room
  async function callPartner() {
    if (!partnerID) {
      alert("No partner in the room yet!");
      return;
    }
    const pc = createPeerConnection(partnerID);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socketRef.current.emit("offer", { payload: offer, target: partnerID });
  }

  async function processQueuedIceCandidates() {
    while (iceCandidateQueue.current.length > 0) {
      const candidate = iceCandidateQueue.current.shift();
      try {
        await peerConnection.current.addIceCandidate(
          new RTCIceCandidate(candidate),
        );
      } catch (e) {
        console.error("Error adding queued ice candidate", e);
      }
    }
  }

  // Click 'Attend'
  async function acceptCall() {
    if (!incomingCall) return;
    const { payload, caller } = incomingCall;
    setIncomingCall(null);

    const pc = createPeerConnection(caller);
    await pc.setRemoteDescription(new RTCSessionDescription(payload));
    processQueuedIceCandidates();

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socketRef.current.emit("answer", { payload: answer, target: caller });
    setCallAccepted(true);
  }

  // Click 'Reject'
  function rejectCall() {
    if (incomingCall) {
      socketRef.current.emit("reject-call", { target: incomingCall.caller });
      setIncomingCall(null);
    }
  }

  const toggleMic = () => {
    const audioTrack = localStream.current?.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      const newMutedState = !audioTrack.enabled;
      setMicMuted(newMutedState);
      if (partnerID) {
        socketRef.current.emit("media-toggle", {
          target: partnerID,
          type: "audio",
          muted: newMutedState,
        });
      }
    }
  };

  const toggleCam = () => {
    const videoTrack = localStream.current?.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      const newMutedState = !videoTrack.enabled;
      setCamMuted(newMutedState);
      if (partnerID) {
        socketRef.current.emit("media-toggle", {
          target: partnerID,
          type: "video",
          muted: newMutedState,
        });
      }
    }
  };

  const cleanupCall = () => {
    if (partnerVideo.current) partnerVideo.current.srcObject = null;
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }
    setCallAccepted(false);
    setIncomingCall(null);
    setRemoteCamMuted(false);
    setRemoteMicMuted(false);
    iceCandidateQueue.current = [];
  };

  return (
    <div
      style={{
        padding: "2rem",
        maxWidth: "900px",
        margin: "0 auto",
        textAlign: "center",
        background: "#0f172a",
        color: "#fff",
        minHeight: "100vh",
        fontFamily: "sans-serif",
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
            onClick={startCall}
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
            Connected to Room: <strong>{roomID}</strong>{" "}
            {partnerID ? "(Partner in room)" : "(Waiting for partner...)"}
          </p>

          {/* Call Partner Button */}
          {partnerID && !callAccepted && !incomingCall && (
            <button
              onClick={callPartner}
              style={{
                marginBottom: "1rem",
                padding: "0.6rem 1.2rem",
                background: "#16a34a",
                color: "#fff",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
                fontWeight: "bold",
              }}
            >
              Call Partner
            </button>
          )}

          {/* Incoming Call UI (Attend / Reject Buttons) */}
          {incomingCall && !callAccepted && (
            <div
              style={{
                background: "#334155",
                padding: "1rem",
                borderRadius: "8px",
                marginBottom: "1.5rem",
              }}
            >
              <p style={{ margin: "0 0 1rem 0", fontWeight: "bold" }}>
                Incoming Video Call...
              </p>
              <button
                onClick={acceptCall}
                style={{
                  background: "#16a34a",
                  color: "#fff",
                  padding: "0.5rem 1.2rem",
                  border: "none",
                  borderRadius: "4px",
                  marginRight: "1rem",
                  cursor: "pointer",
                  fontWeight: "bold",
                }}
              >
                Attend
              </button>
              <button
                onClick={rejectCall}
                style={{
                  background: "#dc2626",
                  color: "#fff",
                  padding: "0.5rem 1.2rem",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                  fontWeight: "bold",
                }}
              >
                Reject
              </button>
            </div>
          )}

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
                You (Local) {micMuted && "(Mic Muted)"}{" "}
                {camMuted && "(Cam Off)"}
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
                Partner (Remote) {remoteMicMuted && "🔇 (Mic Muted)"}
              </p>

              <div
                style={{
                  position: "relative",
                  width: "350px",
                  height: "260px",
                }}
              >
                {/* 1. Show if call is NOT yet accepted */}
                {!callAccepted && (
                  <div
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: "100%",
                      background: "#0f172a",
                      borderRadius: "4px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#94a3b8",
                      fontWeight: "bold",
                    }}
                  >
                    Call not connected
                  </div>
                )}

                {/* 2. Show if call IS accepted, but partner turned off video */}
                {callAccepted && remoteCamMuted && (
                  <div
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: "100%",
                      background: "#0f172a",
                      borderRadius: "4px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#f87171",
                      fontWeight: "bold",
                    }}
                  >
                    Partner Camera is Off
                  </div>
                )}

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

          {callAccepted && (
            <div
              style={{
                marginTop: "1.5rem",
                display: "flex",
                justifyContent: "center",
                gap: "1rem",
              }}
            >
              <button
                onClick={toggleMic}
                style={{
                  padding: "0.6rem 1.2rem",
                  background: micMuted ? "#dc2626" : "#475569",
                  color: "#fff",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                  fontWeight: "bold",
                }}
              >
                {micMuted ? "Unmute Mic" : "Mute Mic"}
              </button>
              <button
                onClick={toggleCam}
                style={{
                  padding: "0.6rem 1.2rem",
                  background: camMuted ? "#dc2626" : "#475569",
                  color: "#fff",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                  fontWeight: "bold",
                }}
              >
                {camMuted ? "Turn Cam On" : "Turn Cam Off"}
              </button>
              <button
                onClick={cleanupCall}
                style={{
                  padding: "0.6rem 1.2rem",
                  background: "#dc2626",
                  color: "#fff",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                  fontWeight: "bold",
                }}
              >
                End Call
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
