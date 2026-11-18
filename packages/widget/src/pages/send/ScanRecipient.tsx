import { useEffect, useRef, useState } from "react";

type QrDetector = { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> };
const Detector = (
  globalThis as typeof globalThis & {
    BarcodeDetector?: new (options: { formats: string[] }) => QrDetector;
  }
).BarcodeDetector;

export function ScanRecipient({ onScan }: { onScan: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!open || !Detector) return;
    const detector = new Detector({ formats: ["qr_code"] });
    const element = video.current;
    let active = true;
    let stream: MediaStream | undefined;
    let frame = 0;
    const stop = () => stream?.getTracks().forEach((track) => track.stop());
    const scan = async () => {
      if (!active || !element) return;
      try {
        const [code] = element.readyState >= 2 ? await detector.detect(element) : [];
        if (!active) return;
        if (code?.rawValue) {
          stop();
          setOpen(false);
          onScan(code.rawValue.trim());
          return;
        }
        frame = requestAnimationFrame(() => void scan());
      } catch {
        if (active) setError(true);
        stop();
      }
    };
    void navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then((media) => {
        stream = media;
        if (!active || !element) {
          stop();
          return;
        }
        element.srcObject = media;
        void scan();
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      stop();
    };
  }, [open, onScan]);

  const policy = (
    document as Document & { featurePolicy?: { allowsFeature(name: string): boolean } }
  ).featurePolicy;
  if (
    !Detector ||
    !navigator.mediaDevices?.getUserMedia ||
    policy?.allowsFeature("camera") === false
  )
    return null;
  return (
    <>
      <button
        type="button"
        className="send-secondary"
        onClick={() => {
          setError(false);
          setOpen(!open);
        }}
      >
        {open ? "Close camera" : "Scan QR"}
      </button>
      {open && (
        <div className="send-scan">
          {error ? (
            <p role="status">Camera unavailable</p>
          ) : (
            <video ref={video} autoPlay muted playsInline />
          )}
        </div>
      )}
    </>
  );
}
