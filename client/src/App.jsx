import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const SOCKET_SERVER_URL =
  import.meta.env.VITE_SOCKET_SERVER_URL || "http://localhost:5656";

const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" },
  ],
};

export default function App() {
  const [roomId, setRoomId] = useState("");
  const [joined, setJoined] = useState(false);
  const [isCalling, setIsCalling] = useState(false);
  const [incomingCall, setIncomingCall] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  const socketRef = useRef(null);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const iceCandidateQueueRef = useRef([]);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const pendingOfferRef = useRef(null); // Replaces window.pendingOffer for safety

  useEffect(() => {
    const initLocalVideo = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
      } catch (err) {
        console.error("Media access error:", err);
        alert("Could not access camera/microphone. Check permissions.");
      }
    };

    initLocalVideo();

    socketRef.current = io(SOCKET_SERVER_URL, {
      transports: ["websocket", "polling"],
    });

    socketRef.current.on("connect", () => {
      console.log("Connected to signaling server:", socketRef.current.id);
      setIsConnected(true);
    });

    socketRef.current.on("connect_error", (err) => {
      console.error("Socket connection error:", err);
      setIsConnected(false);
    });

    socketRef.current.on("room-full", () => {
      alert("Room is full! Maximum 2 participants allowed.");
      resetCallState(false);
    });

    socketRef.current.on("peer-joined", async () => {
      console.log("Peer joined event received. Creating offer as Caller...");
      setIsCalling(true);
      await createOffer();
    });

    socketRef.current.on("offer", async (offer) => {
      console.log("Received incoming call offer from peer");
      pendingOfferRef.current = offer;
      setIncomingCall(true);
    });

    socketRef.current.on("answer", async (answer) => {
      console.log("Received answer from peer");
      if (pcRef.current) {
        await pcRef.current.setRemoteDescription(
          new RTCSessionDescription(answer),
        );
        await processQueuedCandidates();
        setIsCalling(false);
        setInCall(true);
      }
    });

    socketRef.current.on("ice-candidate", async (candidate) => {
      if (pcRef.current && candidate) {
        try {
          if (
            !pcRef.current.remoteDescription ||
            !pcRef.current.remoteDescription.type
          ) {
            iceCandidateQueueRef.current.push(candidate);
          } else {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
          }
        } catch (e) {
          console.error("Error adding ICE candidate", e);
        }
      }
    });

    socketRef.current.on("hangup", () => {
      console.log("Peer hung up the call");
      alert("The other user has left the call.");
      resetCallState(false);
    });

    return () => {
      if (socketRef.current) socketRef.current.disconnect();
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  const processQueuedCandidates = async () => {
    while (iceCandidateQueueRef.current.length > 0) {
      const candidate = iceCandidateQueueRef.current.shift();
      try {
        await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.error("Error adding queued ICE candidate", e);
      }
    }
  };

  const createPeerConnection = (room) => {
    const pc = new RTCPeerConnection(ICE_SERVERS);
    pcRef.current = pc;

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current);
      });
    }

    pc.ontrack = (event) => {
      console.log("SUCCESS: Remote video track received!", event.streams[0]);
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
        remoteVideoRef.current
          .play()
          .catch((err) => console.error("Autoplay blocked:", err));
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current.emit("ice-candidate", {
          roomId: room,
          candidate: event.candidate,
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log("ICE Connection State:", pc.iceConnectionState);
    };

    return pc;
  };

  const joinRoom = async () => {
    const cleanRoomId = roomId.trim();
    if (!cleanRoomId) return alert("Enter or generate a Room ID first");
    if (!isConnected)
      return alert(
        "Still connecting to server. Please wait a few seconds for Render to wake up.",
      );

    console.log("Joining room with ID:", cleanRoomId);
    setRoomId(cleanRoomId);
    setJoined(true);
    socketRef.current.emit("join-room", cleanRoomId);
  };

  const createOffer = async () => {
    const pc = createPeerConnection(roomId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socketRef.current.emit("offer", { roomId, offer });
  };

  const pickCall = async () => {
    setIncomingCall(false);
    setInCall(true);

    const pc = createPeerConnection(roomId);

    if (pendingOfferRef.current) {
      await pc.setRemoteDescription(
        new RTCSessionDescription(pendingOfferRef.current),
      );
      await processQueuedCandidates();

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socketRef.current.emit("answer", { roomId, answer });
    }
  };

  const rejectCall = () => {
    setIncomingCall(false);
    resetCallState(true);
  };

  const resetCallState = (emitHangup = true) => {
    if (emitHangup && roomId && socketRef.current) {
      socketRef.current.emit("hangup", roomId);
    }

    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }

    iceCandidateQueueRef.current = [];
    pendingOfferRef.current = null;
    setJoined(false);
    setIsCalling(false);
    setIncomingCall(false);
    setInCall(false);
    setRoomId("");
  };

  const generateRoomId = () => {
    const randomId = Math.random().toString(36).substring(2, 9);
    setRoomId(randomId);
  };

  return (
    <div
      style={{
        padding: "20px",
        maxWidth: "800px",
        margin: "0 auto",
        textAlign: "center",
        fontFamily: "sans-serif",
      }}
    >
      <h1>WebRTC Video Chat</h1>
      <p
        style={{ fontSize: "14px", color: isConnected ? "#16a34a" : "#dc2626" }}
      >
        Server Status:{" "}
        {isConnected
          ? "Connected 🟢"
          : "Connecting to Render Backend... 🔴 (May take up to 30s)"}
      </p>

      {/* Video Feeds Display */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: "20px",
          margin: "20px 0",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h4>Your Video</h4>
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            style={{
              width: "320px",
              height: "240px",
              background: "#000",
              borderRadius: "8px",
              border: "2px solid #334155",
            }}
          />
        </div>

        <div>
          <h4>Remote Video</h4>
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            style={{
              width: "320px",
              height: "240px",
              background: "#000",
              borderRadius: "8px",
              border: "2px solid #2563eb",
            }}
          />
        </div>
      </div>

      {/* 1. Lobby State */}
      {!joined && !isCalling && !incomingCall && !inCall && (
        <div style={{ margin: "20px 0" }}>
          <div style={{ marginBottom: "10px" }}>
            <button
              onClick={generateRoomId}
              style={{
                padding: "8px 15px",
                background: "#475569",
                color: "#fff",
                border: "none",
                borderRadius: "4px",
                marginRight: "10px",
                cursor: "pointer",
              }}
            >
              Generate Room ID
            </button>
          </div>
          <input
            type="text"
            placeholder="Enter Room ID"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            style={{
              padding: "10px",
              fontSize: "16px",
              marginRight: "10px",
              borderRadius: "4px",
              border: "1px solid #cbd5e1",
              width: "200px",
            }}
          />
          <button
            onClick={joinRoom}
            disabled={!isConnected}
            style={{
              padding: "10px 20px",
              fontSize: "16px",
              background: isConnected ? "#2563eb" : "#94a3b8",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              cursor: isConnected ? "pointer" : "not-allowed",
            }}
          >
            Join Room
          </button>
        </div>
      )}

      {/* 2. Waiting State (First User) */}
      {joined && !isCalling && !incomingCall && !inCall && (
        <div style={{ margin: "20px 0", color: "#64748b" }}>
          <h3>Joined Room: {roomId}</h3>
          <p>Waiting for another user to join...</p>
          <button
            onClick={() => resetCallState(false)}
            style={{
              padding: "8px 16px",
              background: "#475569",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* 3. Calling State */}
      {isCalling && !inCall && (
        <div style={{ margin: "20px 0" }}>
          <h3>Calling peer in room {roomId}...</h3>
          <button
            onClick={() => resetCallState(true)}
            style={{
              padding: "8px 16px",
              background: "#dc2626",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Cancel Call
          </button>
        </div>
      )}

      {/* 4. Incoming Call State */}
      {incomingCall && (
        <div
          style={{
            background: "#1e293b",
            color: "#fff",
            padding: "20px",
            borderRadius: "8px",
            margin: "20px 0",
            border: "2px solid #16a34a",
          }}
        >
          <h3>Incoming Call in Room: {roomId}</h3>
          <button
            onClick={pickCall}
            style={{
              padding: "10px 20px",
              background: "#16a34a",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              marginRight: "10px",
              fontWeight: "bold",
              cursor: "pointer",
            }}
          >
            Pick Up
          </button>
          <button
            onClick={rejectCall}
            style={{
              padding: "10px 20px",
              background: "#dc2626",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Reject
          </button>
        </div>
      )}

      {/* 5. Active Call State */}
      {inCall && (
        <div style={{ marginTop: "20px" }}>
          <button
            onClick={() => resetCallState(true)}
            style={{
              padding: "10px 20px",
              fontSize: "16px",
              background: "#dc2626",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            End Call
          </button>
        </div>
      )}
    </div>
  );
}
