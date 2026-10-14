import React, { useEffect, useRef, useState } from "react";
import io from "socket.io-client";
import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff } from "lucide-react";

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
  const [isCalling, setIsCalling] = useState(false);

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
      setIsCalling(false);
    });

    socketRef.current.on("answer", async ({ payload }) => {
      if (peerConnection.current) {
        await peerConnection.current.setRemoteDescription(
          new RTCSessionDescription(payload),
        );
        processQueuedIceCandidates();
        setCallAccepted(true);
        setIsCalling(false); // Call connected successfully
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

    socketRef.current.on("call-cancelled", () => {
      setIncomingCall(null);
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
    setIsCalling(true);
    const pc = createPeerConnection(partnerID);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socketRef.current.emit("offer", { payload: offer, target: partnerID });
  }

  // Cancel outgoing call
  const cancelCall = () => {
    if (partnerID) {
      socketRef.current.emit("cancel-call", { target: partnerID });
    }
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }
    setIsCalling(false);
    iceCandidateQueue.current = [];
  };

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

  // Click 'Attend' buttons
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
    setIsCalling(false);
    setIncomingCall(null);
    setRemoteCamMuted(false);
    setRemoteMicMuted(false);
    iceCandidateQueue.current = [];
  };

  return (
    <div className="w-dvw h-screen flex bg-slate-50 select-none lg:p-2">
      <div className="h-screen w-full lg:h-[80dvh] lg:w-fit lg:aspect-14/9 group m-auto bg-white shadow-2xl lg:rounded-2xl overflow-hidden relative">
        {!inRoom ? (
          <div className="w-full h-full flex">
            <div className="m-auto w-fit p-2">
              <input
                type="text"
                placeholder="Enter Room ID (e.g. room123)"
                value={inputRoom}
                onChange={(e) => setInputRoom(e.target.value)}
                className="py-3 px-4 h-13 mr-2 bg-slate-100 font-normal text-base rounded-md outline-0 border-2 border-gray-200 focus:border-blue-500"
              />
              <button
                onClick={startCall}
                className="p-3 h-13 bg-blue-600 text-white font-medium text-base rounded-md outline-0 cursor-pointer"
              >
                Join Room
              </button>
            </div>
          </div>
        ) : (
          <div className="w-full h-full relative">
            <p className="absolute top-8 left-2 font-normal text-sm text-white z-5 transition-opacity duration-200 opacity-0 group-hover:opacity-100">
              Connected to Room: <strong>{roomID}</strong>{" "}
              {partnerID ? "(Partner in room)" : "(Waiting for partner...)"}
            </p>

            {/* CALL CONTROLLS BEFORE ATTEND */}
            <div className=" absolute z-5 bottom-5 left-1/2 w-fit transform -translate-x-1/2">
              {/* Call Partner Button */}
              {partnerID && !callAccepted && !incomingCall && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={callPartner}
                    disabled={isCalling}
                    className="bg-green-500 whitespace-nowrap text-white font-medium px-4 h-14 rounded-full outline-0 cursor-pointer"
                  >
                    {isCalling ? "Calling..." : "Call Partner"}
                  </button>
                  {isCalling && (
                    <button
                      onClick={cancelCall}
                      className="bg-slate-500 whitespace-nowrap text-white font-medium px-4 h-14 rounded-full outline-0 cursor-pointer"
                    >
                      Cancel Call
                    </button>
                  )}
                </div>
              )}

              {/* Incoming Call UI (Attend / Reject Buttons) */}
              {incomingCall && !callAccepted && (
                <div>
                  <p className="text-white font-medium text-center mb-4">
                    Incoming video call...
                  </p>
                  <div className="w-full flex items-center gap-x-3">
                    <button
                      onClick={acceptCall}
                      className="bg-green-500 flex items-center gap-x-2 text-white font-medium px-4 h-14 rounded-full outline-0 cursor-pointer"
                    >
                      <Phone className="text-white size-5 flex-none" />
                      <span>Attend</span>
                    </button>
                    <button
                      onClick={rejectCall}
                      className="bg-red-500 flex items-center gap-x-2 text-white font-medium px-4 h-14 rounded-full outline-0 cursor-pointer"
                    >
                      <PhoneOff className="text-white size-5 flex-none" />
                      <span>Reject</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Call controlls */}
              {callAccepted && (
                <div className="flex gap-x-4">
                  <button
                    onClick={toggleMic}
                    className="bg-slate-500 text-white flex font-medium flex-none w-14 h-14 rounded-full outline-0 cursor-pointer"
                  >
                    {micMuted ? (
                      <Mic className="text-white size-6 m-auto" />
                    ) : (
                      <MicOff className="text-white size-6 m-auto" />
                    )}
                    <span className="sr-only">
                      {micMuted ? "Unmute Mic" : "Mute Mic"}
                    </span>
                  </button>
                  <button
                    onClick={toggleCam}
                    className="bg-slate-500 text-white flex font-medium flex-none w-14 h-14 rounded-full outline-0 cursor-pointer"
                  >
                    {camMuted ? (
                      <Video className="text-white size-6 m-auto" />
                    ) : (
                      <VideoOff className="text-white size-6 m-auto" />
                    )}
                    <span className="sr-only">
                      {camMuted ? "Turn Cam On" : "Turn Cam Off"}
                    </span>
                  </button>
                  <button
                    onClick={cleanupCall}
                    className="bg-red-500 text-white flex font-medium flex-none w-14 h-14 rounded-full outline-0 cursor-pointer"
                  >
                    <PhoneOff className="text-white size-6 m-auto" />
                    <span className="sr-only">End Call</span>
                  </button>
                </div>
              )}
            </div>

            {/* LOCAL USER VIDEO PREVIEW */}
            {/* !incomingCall && callAccepted && */}
            <div className="h-45 hover:h-55 aspect-9/14 rounded-lg overflow-hidden absolute top-4 right-4 z-10 transition-all duration-200">
              <p className="absolute bottom-2 left-2 text-white gap-2 flex items-center">
                <span>You</span>
                {micMuted && <MicOff className="text-white size-4" />}
              </p>
              <div className="absolute w-fit top-1/2 left-1/2 transform -translate-y-1/2 -translate-x-1/2 z-5">
                {camMuted && <VideoOff className="text-white size-6" />}
              </div>
              <video
                ref={userVideo}
                autoPlay
                muted
                playsInline
                className="w-full h-full bg-black object-cover"
              />
            </div>

            {/* REMOTE USER VIDEO PREVIEW */}
            <div className="absolute w-full h-full top-0 left-0">
              <p className="absolute top-2 left-2 text-white z-10 transition-opacity duration-200 opacity-0 group-hover:opacity-100">
                Partner (Remote)
              </p>

              {/* 1. Show if call is NOT yet accepted */}
              {!callAccepted && (
                <div className="absolute top-0 left-0 w-full h-full flex items-center justify-center text-[#94a3b8] font-medium">
                  {isCalling ? "Calling partner..." : "Call not connected"}
                </div>
              )}

              {remoteMicMuted && (
                <div className="absolute top-0 left-0 w-full h-full flex items-center justify-center text-[#94a3b8] font-medium">
                  Partner mic muted
                </div>
              )}

              {/* 2. Show if call IS accepted, but partner turned off video */}
              {callAccepted && remoteCamMuted && (
                <div className="absolute top-0 left-0 w-full h-full flex items-center justify-center text-[#94a3b8] font-medium">
                  Partner Camera is Off
                </div>
              )}

              <video
                ref={partnerVideo}
                autoPlay
                playsInline
                className="w-full h-full bg-black object-cover"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
