"use client";
import React, { useEffect, useState, useRef, useCallback } from "react";
import localforage from "localforage";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";

import { FFmpeg } from "@ffmpeg/ffmpeg";
import reencodeVideo from "./reencodeVideo";
import { toBlobURL } from "@ffmpeg/util";

// Configure localforage
if (typeof window !== "undefined") {
  localforage.config({
    driver: localforage.INDEXEDDB,
    name: "solder",
    version: 1,
  });
}

const chunksStore = localforage.createInstance({
  name: "chunks",
});

interface PerformanceStats {
  fps: number;
  chunkSize: number;
  processingTime: number;
}

interface RecordingSettings {
  quality: string;
  fps: string;
  recordingType: string;
  micActive: boolean;
}

const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";

const Recorder = () => {
  // State
  const [started, setStarted] = useState(false);
  const [recording, setRecording] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const [performanceStats, setPerformanceStats] =
    useState<PerformanceStats | null>(null);
  const [settings, setSettings] = useState<RecordingSettings>({
    quality: "1080p",
    fps: "60",
    recordingType: "screen",
    micActive: true,
  });
  const [useAdaptiveFilter, setUseAdaptiveFilter] = useState(true);

  // Refs
  const liveStream = useRef<MediaStream | null>(null);
  const helperVideoStream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const audioDestination = useRef<MediaStreamAudioDestinationNode | null>(null);
  const audioInputGain = useRef<GainNode | null>(null);
  const audioOutputGain = useRef<GainNode | null>(null);
  const chunkIndex = useRef(0);
  const hasChunks = useRef(false);
  const isFinishing = useRef(false);
  const lastTimecode = useRef<number>(0); // Track last timecode for chunk deduplication
  const ffmpegRef = useRef<unknown>(null); // Store ffmpeg instance
  // Add new refs for improved chunk and state management
  const isRestarting = useRef(false);
  const sentLast = useRef(false);
  const index = useRef(0);

  // Load saved settings
  useEffect(() => {
    const savedQuality = localStorage.getItem("qualityValue");
    const savedFps = localStorage.getItem("fpsValue");
    const savedRecordingType = localStorage.getItem("recordingType");
    const savedMicActive = localStorage.getItem("micActive");

    setSettings((prev) => ({
      ...prev,
      quality: savedQuality || prev.quality,
      fps: savedFps || prev.fps,
      recordingType: savedRecordingType || prev.recordingType,
      micActive:
        savedMicActive !== null ? JSON.parse(savedMicActive) : prev.micActive,
    }));
  }, []);

  // Utility functions
  const base64ToBlob = (base64: string): Blob => {
    const dataUrlRegex = /^data:(.*?);base64,/;
    const matches = base64.match(dataUrlRegex);

    if (matches) {
      const mimeType = matches[1];
      const binaryString = atob(base64.slice(matches[0].length));
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return new Blob([bytes], { type: mimeType });
    } else {
      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return new Blob([bytes], { type: "video/webm" });
    }
  };

  const getBitrateSettings = (quality: string) => {
    const settings = {
      "4k": { audio: 128000, video: 25000000 },
      "1080p": { audio: 128000, video: 6000000 },
      "720p": { audio: 96000, video: 3000000 },
      "480p": { audio: 64000, video: 1500000 },
      "360p": { audio: 64000, video: 800000 },
      "240p": { audio: 48000, video: 400000 },
    };
    return settings[quality as keyof typeof settings] || settings["1080p"];
  };

  const getResolutionSettings = (quality: string) => {
    const settings = {
      "4k": { width: 3840, height: 2160 },
      "1080p": { width: 1920, height: 1080 },
      "720p": { width: 1280, height: 720 },
      "480p": { width: 854, height: 480 },
      "360p": { width: 640, height: 360 },
      "240p": { width: 426, height: 240 },
    };
    return settings[quality as keyof typeof settings] || settings["1080p"];
  };

  const getSupportedMimeType = (): string => {
    const codecs = [
      "video/webm;codecs=avc1",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm;codecs=h264",
      "video/webm",
    ];

    for (const codec of codecs) {
      if (MediaRecorder.isTypeSupported(codec)) {
        return codec;
      }
    }
    return "video/webm;codecs=vp8,opus";
  };

  const saveSettings = useCallback(
    (newSettings: Partial<RecordingSettings>) => {
      setSettings((prev) => {
        const updated = { ...prev, ...newSettings };

        // Save to localStorage
        if (newSettings.quality)
          localStorage.setItem("qualityValue", newSettings.quality);
        if (newSettings.fps) localStorage.setItem("fpsValue", newSettings.fps);
        if (newSettings.recordingType)
          localStorage.setItem("recordingType", newSettings.recordingType);
        if (newSettings.micActive !== undefined)
          localStorage.setItem(
            "micActive",
            JSON.stringify(newSettings.micActive)
          );

        return updated;
      });
    },
    []
  );

  // Download functionality
  const downloadVideo = useCallback(async (base64?: string, title?: string) => {
    setDownloading(true);

    try {
      let webmBlob: Blob;

      if (base64) {
        webmBlob = base64ToBlob(base64);
      } else {
        const chunkArray: { index: number; chunk: Blob }[] = [];
        await chunksStore.iterate((value: { chunk: Blob; index: number }) => {
          chunkArray.push({ index: value.index, chunk: value.chunk });
        });
        if (chunkArray.length === 0) {
          alert("No recording chunks found. Please try recording again.");
          setDownloading(false);
          return;
        }

        chunkArray.sort((a, b) => a.index - b.index);
        webmBlob = new Blob(
          chunkArray.map((c) => c.chunk),
          { type: "video/webm" }
        );
      }

      // Use a ref to store and reuse the ffmpeg instance
      if (!ffmpegRef.current) {
        ffmpegRef.current = new FFmpeg();
      }
      const ffmpeg = ffmpegRef.current as FFmpeg;
      await ffmpeg.load({
        coreURL: await toBlobURL(
          `${baseURL}/ffmpeg-core.js`,
          "text/javascript"
        ),
        wasmURL: await toBlobURL(
          `${baseURL}/ffmpeg-core.wasm`,
          "application/wasm"
        ),
      });
      const reencodedBlob = await reencodeVideo(ffmpeg, webmBlob);

      // Download the MP4
      const safeTitle =
        (title?.replace(/[\/\\:?~<>|*"]/g, "_") || "recording") + ".mp4";
      const url = URL.createObjectURL(reencodedBlob);
      const link = document.createElement("a");
      link.href = url;
      link.download = safeTitle;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Download error:", error);
      alert(
        "Failed to export video. Try a shorter recording or check the console for errors."
      );
    } finally {
      setDownloading(false);
    }
  }, []);

  // Audio mixing functions
  const setAudioInputVolume = (volume: number) => {
    if (audioInputGain.current) {
      audioInputGain.current.gain.value = volume;
    }
  };

  const setAudioOutputVolume = (volume: number) => {
    if (audioOutputGain.current) {
      audioOutputGain.current.gain.value = volume;
    }
  };

  // Recording functions
  const stopRecording = useCallback(async () => {
    isFinishing.current = true;

    if (recorder.current) {
      recorder.current.stop();
      recorder.current = null;
    }

    // Stop all streams
    [liveStream, helperVideoStream].forEach((streamRef) => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
    });

    // Clean up audio context
    if (audioContext.current) {
      await audioContext.current.close();
      audioContext.current = null;
      audioDestination.current = null;
      audioInputGain.current = null;
      audioOutputGain.current = null;
    }

    setRecording(false);
    localStorage.setItem("recording", "false");
  }, []);

  const startRecording = useCallback(async () => {
    if (recorder.current || !liveStream.current) {
      return;
    }

    if (liveStream.current.getTracks().length === 0) {
      console.error("No tracks in live stream");
      return;
    }

    // Clear previous chunks
    chunksStore.clear();
    hasChunks.current = false;
    chunkIndex.current = 0;
    index.current = 0;
    lastTimecode.current = 0;
    sentLast.current = false;
    isRestarting.current = false;

    try {
      const { audio: audioBitsPerSecond, video: videoBitsPerSecond } =
        getBitrateSettings(settings.quality);
      const mimeType = getSupportedMimeType();

      if (!MediaRecorder.isTypeSupported(mimeType)) {
        console.error("MimeType not supported:", mimeType);
        return;
      }

      const recorderOptions: MediaRecorderOptions = {
        mimeType,
        videoBitsPerSecond,
        audioBitsPerSecond,
      };

      recorder.current = new MediaRecorder(liveStream.current, recorderOptions);
      // Use smaller chunk intervals to reduce lag
      const chunkInterval = 500; // 500ms for all qualities

      recorder.current.start(chunkInterval);
      setRecording(true);

      localStorage.setItem("recording", "true");

      // Handle data available
      recorder.current.ondataavailable = async (e: BlobEvent) => {
        // Optional: Check available storage before saving
        try {
          const { quota, usage } = await navigator.storage.estimate();
          const minMemory = 26214400; // 25MB
          if (quota && quota - (usage || 0) < minMemory) {
            alert("Low storage space. Stopping recording.");
            stopRecording();
            return;
          }
        } catch {}

        if (e.data.size > 0) {
          const timestamp =
            (e as BlobEvent & { timecode?: number }).timecode ?? Date.now();
          if (hasChunks.current === false) {
            hasChunks.current = true;
            lastTimecode.current = timestamp;
          } else if (timestamp < lastTimecode.current) {
            return;
          } else {
            lastTimecode.current = timestamp;
          }

          try {
            const chunkData = {
              index: index.current,
              chunk: e.data,
              timestamp,
            };
            await chunksStore.setItem(`chunk_${index.current}`, chunkData);
            index.current++;
            chunkIndex.current = index.current;
            hasChunks.current = true;

            const processingTime = performance.now(); // Optionally update stats here
            if (processingTime < 1000) {
              setPerformanceStats({
                fps: parseInt(settings.fps),
                chunkSize: e.data.size,
                processingTime,
              });
            }
          } catch {
            alert("Error saving chunk. Stopping recording.");
            setRecording(false);
            localStorage.setItem("recording", "false");
            stopRecording();
          }
        } else {
          if (recorder.current && recorder.current.state === "inactive") {
            setRecording(false);
            localStorage.setItem("recording", "false");
          }
        }

        if (isFinishing.current) {
          sentLast.current = true;
        }
      };

      recorder.current.onstop = () => {
        if (isRestarting.current) return;
        setTimeout(() => {
          if (!sentLast.current) {
            setRecording(false);
            isFinishing.current = false;
          }
        }, 3000);
        isRestarting.current = false;
      };

      recorder.current.onerror = (event) => {
        console.error("MediaRecorder error:", event);
      };
    } catch (err) {
      console.error("Recording error:", err);
    }
  }, [settings, stopRecording]);

  const createMixedAudioStream = useCallback(
    async (
      screenStream: MediaStream,
      micStream: MediaStream,
      useAdaptiveFilter: boolean
    ) => {
      audioContext.current = new AudioContext();
      audioDestination.current =
        audioContext.current.createMediaStreamDestination();

      const screenAudioTracks = screenStream.getAudioTracks();
      const micAudioTracks = micStream.getAudioTracks();

      if (screenAudioTracks.length > 0 && micAudioTracks.length > 0) {
        const screenSource =
          audioContext.current.createMediaStreamSource(screenStream);
        const micSource =
          audioContext.current.createMediaStreamSource(micStream);

        if (useAdaptiveFilter) {
          // Load the AudioWorkletProcessor
          if (!audioContext.current.audioWorklet) {
            throw new Error("AudioWorklet not supported");
          }
          await audioContext.current.audioWorklet.addModule(
            "/AdaptiveFilterProcessor.js"
          );
          // Adaptive filter node
          const adaptiveFilterNode = new AudioWorkletNode(
            audioContext.current,
            "adaptive-filter-processor",
            {
              numberOfInputs: 2,
              numberOfOutputs: 1,
              channelCount: 1,
            }
          );
          // Connect sources to the adaptive filter
          micSource.connect(adaptiveFilterNode, 0, 0);
          screenSource.connect(adaptiveFilterNode, 0, 1);
          adaptiveFilterNode.connect(audioDestination.current);
        } else {
          // Mix both sources directly (no filter)
          micSource.connect(audioDestination.current);
          screenSource.connect(audioDestination.current);
        }
        setAudioInputVolume(1.0);
        setAudioOutputVolume(0.5);
      } else if (micAudioTracks.length > 0) {
        const micSource =
          audioContext.current.createMediaStreamSource(micStream);
        audioInputGain.current = audioContext.current.createGain();
        micSource.connect(audioInputGain.current);
        audioInputGain.current.connect(audioDestination.current);
        setAudioInputVolume(1.0);
      } else if (screenAudioTracks.length > 0) {
        const screenSource =
          audioContext.current.createMediaStreamSource(screenStream);
        audioOutputGain.current = audioContext.current.createGain();
        screenSource.connect(audioOutputGain.current);
        audioOutputGain.current.connect(audioDestination.current);
        setAudioOutputVolume(0.5);
      }

      return audioDestination.current.stream;
    },
    []
  );

  const startStream = useCallback(async () => {
    const { width, height } = getResolutionSettings(settings.quality);
    const fps = parseInt(settings.fps);

    try {
      const videoConstraints: MediaTrackConstraints = {
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: fps },
      };

      if (settings.quality === "4k" || settings.quality === "1080p") {
        videoConstraints.width = { ideal: width, max: width };
        videoConstraints.height = { ideal: height, max: height };
      }

      // Get screen stream
      helperVideoStream.current = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: videoConstraints,
      });

      if (
        !helperVideoStream.current ||
        helperVideoStream.current.getVideoTracks().length === 0
      ) {
        throw new Error("No video tracks available");
      }

      // Handle audio mixing for screen recording with microphone
      if (settings.micActive) {
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false,
          });

          const mixedAudioStream = await createMixedAudioStream(
            helperVideoStream.current,
            micStream,
            useAdaptiveFilter
          );
          const videoTracks = helperVideoStream.current.getVideoTracks();
          const audioTracks = mixedAudioStream.getAudioTracks();

          liveStream.current = new MediaStream([
            ...videoTracks,
            ...audioTracks,
          ]);
        } catch (micError) {
          console.warn(
            "Failed to get microphone audio, using screen audio only:",
            micError
          );
          liveStream.current = helperVideoStream.current;
        }
      } else {
        liveStream.current = helperVideoStream.current;
      }

      setStarted(true);
      await startRecording();
    } catch (err) {
      console.error("Stream creation error:", err);
    }
  }, [settings, startRecording, useAdaptiveFilter, createMixedAudioStream]);

  // Event handlers
  const handleStartRecording = () => {
    startStream();
  };

  const handleStopRecording = () => {
    stopRecording();
  };

  const handleDownload = () => {
    downloadVideo();
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6">
      {/* Header */}
      <div className="text-center mb-12">
        <h1 className="text-4xl font-bold text-foreground mb-3">
          Screen Recorder
        </h1>
        <p className="text-muted-foreground">Record your screen with ease</p>
      </div>

      {/* Main Content */}
      <div className="w-full max-w-md space-y-8">
        {!started && (
          <>
            {/* Quality Settings */}
            <div className="space-y-6">
              <div>
                <label className="text-sm font-medium text-foreground mb-3 block">
                  Quality
                </label>
                <Select
                  value={settings.quality}
                  onValueChange={(value: string) =>
                    saveSettings({ quality: value })
                  }
                >
                  <SelectTrigger className="w-full h-12">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="4k">4K</SelectItem>
                    <SelectItem value="1080p">1080p</SelectItem>
                    <SelectItem value="720p">720p</SelectItem>
                    <SelectItem value="480p">480p</SelectItem>
                    <SelectItem value="360p">360p</SelectItem>
                    <SelectItem value="240p">240p</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-sm font-medium text-foreground mb-3 block">
                  Frame Rate
                </label>
                <Select
                  value={settings.fps}
                  onValueChange={(value: string) =>
                    saveSettings({ fps: value })
                  }
                >
                  <SelectTrigger className="w-full h-12">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="120">120 FPS</SelectItem>
                    <SelectItem value="60">60 FPS</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Microphone Toggle */}
              <div className="flex items-center justify-between p-4 bg-muted rounded-lg border">
                <div>
                  <div className="font-medium text-foreground">
                    Include Microphone
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Record audio from your microphone
                  </div>
                </div>
                <Checkbox
                  id="micActive"
                  checked={settings.micActive}
                  onCheckedChange={(checked: boolean) =>
                    saveSettings({ micActive: checked })
                  }
                />
              </div>
              {/* Adaptive Filter Toggle (only before recording) */}
              <div className="flex items-center justify-between p-4 bg-muted rounded-lg border">
                <div>
                  <div className="font-medium text-foreground">
                    Echo Cancellation (Adaptive Filter)
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Remove system audio echo from mic (recommended). When
                    enabled, your microphone will be filtered to reduce feedback
                    and echo from system audio. When disabled, both audio
                    sources are simply mixed.
                  </div>
                </div>
                <Checkbox
                  id="adaptiveFilter"
                  checked={useAdaptiveFilter}
                  onCheckedChange={(checked: boolean) =>
                    setUseAdaptiveFilter(checked)
                  }
                />
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                <span className="font-semibold">Current: </span>
                {useAdaptiveFilter ? (
                  <span className="text-green-600 font-semibold">
                    Echo Cancellation ON
                  </span>
                ) : (
                  <span className="text-red-600 font-semibold">
                    Echo Cancellation OFF
                  </span>
                )}
              </div>
              <div className="text-xs text-yellow-600 mt-1">
                You can only change this setting before starting a recording.
              </div>
            </div>

            {/* Start Button */}
            <Button onClick={handleStartRecording} className="w-full" size="lg">
              Start Recording
            </Button>
          </>
        )}

        {/* Recording State */}
        {started && recording && (
          <div className="text-center space-y-6">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-destructive/10 rounded-full">
              <div className="w-4 h-4 bg-destructive rounded-full animate-pulse"></div>
            </div>

            {/* Echo Cancellation Status Badge */}
            <div className="flex justify-center mb-2">
              <span
                className={`px-3 py-1 rounded-full text-xs font-bold ${
                  useAdaptiveFilter
                    ? "bg-green-100 text-green-700"
                    : "bg-red-100 text-red-700"
                }`}
              >
                Echo Cancellation: {useAdaptiveFilter ? "ON" : "OFF"}
              </span>
            </div>

            <div>
              <h2 className="text-2xl font-bold text-foreground mb-2">
                Recording in Progress
              </h2>
            </div>

            {performanceStats && (
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div className="bg-muted rounded-lg p-3 border">
                  <div className="font-medium text-foreground">
                    {settings.quality}
                  </div>
                  <div className="text-muted-foreground">Quality</div>
                </div>
                <div className="bg-muted rounded-lg p-3 border">
                  <div className="font-medium text-foreground">
                    {performanceStats.fps} FPS
                  </div>
                  <div className="text-muted-foreground">Frame Rate</div>
                </div>
                <div className="bg-muted rounded-lg p-3 border">
                  <div className="font-medium text-foreground">
                    {(performanceStats.chunkSize / 1024 / 1024).toFixed(1)}MB
                  </div>
                  <div className="text-muted-foreground">Chunk Size</div>
                </div>
              </div>
            )}

            <Button
              onClick={handleStopRecording}
              variant="destructive"
              size="lg"
              className="w-full"
            >
              Stop Recording
            </Button>
          </div>
        )}

        {/* Recording Complete */}
        {started && !recording && (
          <div className="text-center space-y-6">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-green-100 rounded-full">
              <div className="w-4 h-4 bg-green-500 rounded-full"></div>
            </div>

            <div>
              <h2 className="text-2xl font-bold text-foreground mb-2">
                Recording Complete
              </h2>

              <p className="text-muted-foreground">
                Your recording has been saved and is ready to download.
              </p>
            </div>

            <Button
              onClick={handleDownload}
              disabled={downloading}
              className="w-full"
              size="lg"
            >
              {downloading ? "Downloading..." : "Download Video"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

export default Recorder;
