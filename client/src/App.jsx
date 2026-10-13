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

  // New States for Call Controls & Incoming Call
  const [incomingCall, setIncomingCall] = useState(null);
  const [callAccepted, setCallAccepted] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [camMuted, setCamMuted] = useState(false);
  const [partnerID, setPartnerID] = useState(null);

  const socketRef = useRef();
  const userVideo = useRef();
  const partnerVideo = useRef();
  const peerConnection = useRef();
  const localStream = useRef();

  useEffect(() => {
    socketRef.current = io(serverURL);

    socketRef.current.on("other-user", (id) => {
      setPartnerID(id);
      callUser(id);
    });

    socketRef.current.on("user-joined", (id) => {
      setPartnerID(id);
    });

    socketRef.current.on("incoming-call", ({ signal, from }) => {
      setPartnerID(from);
      setIncomingCall({ signal, from });
    });

    socketRef.current.on("call-accepted", async (signal) => {
      setCallAccepted(true);
      await peerConnection.current.setRemoteDescription(
        new RTCSessionDescription(signal),
      );
    });

    socketRef.current.on("call-rejected", () => {
      alert("Call rejected by partner");
      cleanupCall();
    });

    socketRef.current.on("offer", async ({ payload, caller }) => {
      await createPeerConnection(caller);
      await peerConnection.current.setRemoteDescription(
        new RTCSessionDescription(payload),
      );
      const answer = await peerConnection.current.createAnswer();
      await peerConnection.current.setLocalDescription(answer);
      socketRef.current.emit("answer", { payload: answer, target: caller });
      setCallAccepted(true);
    });

    socketRef.current.on("answer", async ({ payload }) => {
      await peerConnection.current.setRemoteDescription(
        new RTCSessionDescription(payload),
      );
    });

    socketRef.current.on("ice-candidate", async ({ candidate }) => {
      if (candidate && peerConnection.current) {
        try {
          await peerConnection.current.addIceCandidate(
            new RTCIceCandidate(candidate),
          );
        } catch (e) {
          console.error("Error receiving ice candidate", e);
        }
      }
    });

    socketRef.current.on("user-disconnected", () => {
      cleanupCall();
      alert("Partner disconnected");
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

  async function callUser(targetID) {
    const pc = createPeerConnection(targetID);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Instead of direct offer, send ring/incoming-call notification
    socketRef.current.emit("call-user", {
      userToCall: targetID,
      signal: offer,
    });
  }

  async function acceptCall() {
    setIncomingCall(null);
    setCallAccepted(true);
    const pc = createPeerConnection(incomingCall.from);
    await pc.setRemoteDescription(
      new RTCSessionDescription(incomingCall.signal),
    );
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socketRef.current.emit("accept-call", {
      to: incomingCall.from,
      signal: answer,
    });
  }

  function rejectCall() {
    socketRef.current.emit("reject-call", { to: incomingCall.from });
    setIncomingCall(null);
  }

  const toggleMic = () => {
    const audioTrack = localStream.current?.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      setMicMuted(!audioTrack.enabled);
    }
  };

  const toggleCam = () => {
    const videoTrack = localStream.current?.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      setCamMuted(!videoTrack.enabled);
    }
  };

  const cleanupCall = () => {
    if (partnerVideo.current) partnerVideo.current.srcObject = null;
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }
    setCallAccepted(false);
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
            Connected to Room: <strong>{roomID}</strong>
          </p>

          {incomingCall && !callAccepted && (
            <div
              style={{
                background: "#334155",
                padding: "1rem",
                borderRadius: "8px",
                marginBottom: "1.5rem",
              }}
            >
              <p style={{ margin: "0 0 1rem 0" }}>Incoming Call...</p>
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

          {/* Call Control Buttons: Mic Mute, Camera Mute, End Call */}
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
