import { useCallback, useEffect, useRef, useState } from "react";
import { Environment } from "../../wailsjs/runtime/runtime";

export type VoicePhase = "idle" | "recording";

function getSpeechRecognition(): any {
  return (
    (window as any).SpeechRecognition ||
    (window as any).webkitSpeechRecognition ||
    null
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong.";
}

// What to tell people when the web view can't do speech recognition. On
// macOS it works (WebKit uses Apple's speech engine). WebView2 on Windows
// exposes the API but fails with a "network" error, and WebKitGTK on Linux
// has no speech recognition at all.
function unavailableMessage(platform: string): string {
  if (platform === "windows") {
    return "Voice input isn't available in the Windows version. Press Win+H in a text field to use Windows voice typing instead.";
  }
  if (platform === "linux") {
    return "Voice input isn't available on Linux.";
  }
  return "Voice input isn't available on this system.";
}

interface Options {
  /** Called once per recording with everything that was said. */
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}

/**
 * Voice input through the web view's built-in speech recognition (the Web
 * Speech API). Final results are collected while recording and delivered
 * together when it stops.
 */
export function useVoiceInput({ onTranscript, onError }: Options) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [platform, setPlatform] = useState("");
  const phaseRef = useRef<VoicePhase>("idle");
  const recognitionRef = useRef<any>(null);
  const finalRef = useRef<string[]>([]);
  const interimRef = useRef("");
  const failedRef = useRef(false);

  // Keep the latest callbacks without re-creating start/stop.
  const callbacks = useRef({ onTranscript, onError });
  callbacks.current = { onTranscript, onError };

  useEffect(() => {
    Environment()
      .then((env) => setPlatform(env.platform))
      .catch(() => setPlatform(""));
  }, []);

  const updatePhase = (next: VoicePhase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  const start = useCallback(() => {
    if (phaseRef.current !== "idle") return;

    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition || platform === "linux") {
      callbacks.current.onError(unavailableMessage(platform));
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    finalRef.current = [];
    interimRef.current = "";
    failedRef.current = false;

    recognition.onresult = (event: any) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalRef.current.push(text.trim());
        } else {
          interim += text;
        }
      }
      interimRef.current = interim;
    };

    recognition.onerror = (event: any) => {
      console.error("Speech recognition error", event.error);
      if (event.error === "no-speech" || event.error === "aborted") return;
      failedRef.current = true;
      const message =
        event.error === "not-allowed" || event.error === "service-not-allowed"
          ? "Microphone or speech recognition access was denied. Allow it in your system's privacy settings and try again."
          : event.error === "network"
            ? unavailableMessage(platform)
            : `Speech recognition failed (${event.error}).`;
      callbacks.current.onError(message);
    };

    recognition.onend = () => {
      const text = [...finalRef.current, interimRef.current.trim()]
        .filter(Boolean)
        .join(" ");
      finalRef.current = [];
      interimRef.current = "";
      recognitionRef.current = null;
      updatePhase("idle");
      if (!failedRef.current) {
        callbacks.current.onTranscript(text);
      }
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
      updatePhase("recording");
    } catch (error) {
      callbacks.current.onError(errorMessage(error));
    }
  }, [platform]);

  // Stop listening; onend delivers the transcript.
  const stop = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    } else {
      updatePhase("idle");
    }
  }, []);

  // Stop listening and throw away what was said.
  const cancel = useCallback(() => {
    const recognition = recognitionRef.current;
    if (recognition) {
      recognition.onend = null;
      recognition.abort?.();
      recognitionRef.current = null;
    }
    finalRef.current = [];
    interimRef.current = "";
    updatePhase("idle");
  }, []);

  useEffect(() => () => recognitionRef.current?.abort?.(), []);

  return { phase, start, stop, cancel };
}
