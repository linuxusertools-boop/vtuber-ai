import { useEffect, useRef, useState } from "react";

interface Props {
  expression?: string;
  talking?: boolean;
}

// Haohao / Huohuo — light purple-white hair, teal/green eyes, staff-bearer look
const expressionStyles: Record<string, {
  eyeScale?: number;
  browY?: number;
  mouthShape?: string;
  cheek?: boolean;
  headTilt?: number;
  eyeColor?: string;
}> = {
  Senang:   { eyeScale: 1.05, browY: -2, mouthShape: "smile-big",  cheek: true,  eyeColor: "#9e9e9e" },
  Sedih:    { eyeScale: 0.75, browY: 3,  mouthShape: "frown",      cheek: false, eyeColor: "#9e9e9e" },
  Malu:     { eyeScale: 0.82, browY: -1, mouthShape: "smile-sm",   cheek: true,  headTilt: 5,  eyeColor: "#9e9e9e" },
  Tsundere: { eyeScale: 0.9,  browY: 1,  mouthShape: "pout",       cheek: false, headTilt: -6, eyeColor: "#9e9e9e" },
  Marah:    { eyeScale: 1.1,  browY: 4,  mouthShape: "frown-big",  cheek: false, eyeColor: "#6d6d6d" },
  Kaget:    { eyeScale: 1.45, browY: -5, mouthShape: "open-big",   cheek: false, eyeColor: "#9e9e9e" },
  Bingung:  { eyeScale: 0.88, browY: -2, mouthShape: "wavy",       cheek: false, headTilt: 4,  eyeColor: "#9e9e9e" },
  Serius:   { eyeScale: 0.95, browY: 2,  mouthShape: "flat",       cheek: false, eyeColor: "#9e9e9e" },
};

export default function CSSAvatar({ expression = "Senang", talking = false }: Props) {
  const style = expressionStyles[expression] ?? expressionStyles["Senang"];
  const [blinking, setBlinking] = useState(false);
  const [headX, setHeadX] = useState(0);
  const [headY, setHeadY] = useState(0);
  const [mouthOpen, setMouthOpen] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const animRef = useRef<number | undefined>(undefined);
  const tRef = useRef(0);
  const talkRef = useRef(0);

  useEffect(() => {
    const blink = () => {
      setBlinking(true);
      setTimeout(() => setBlinking(false), 110);
      timerRef.current = setTimeout(blink, 2800 + Math.random() * 2800);
    };
    timerRef.current = setTimeout(blink, 1200);
    return () => clearTimeout(timerRef.current);
  }, []);

  useEffect(() => {
    const animate = () => {
      tRef.current += 0.016;
      const t = tRef.current;
      setHeadX(Math.sin(t * 0.42) * 4 + Math.sin(t * 0.69) * 1.6);
      setHeadY(Math.sin(t * 0.31) * 2.8);
      animRef.current = requestAnimationFrame(animate);
    };
    animRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animRef.current!);
  }, []);

  useEffect(() => {
    if (!talking) { setMouthOpen(0); return; }
    const go = () => {
      talkRef.current += 0.28;
      setMouthOpen(Math.abs(Math.sin(talkRef.current)) * 0.85);
      animRef.current = requestAnimationFrame(go);
    };
    const id = requestAnimationFrame(go);
    return () => cancelAnimationFrame(id);
  }, [talking]);

  const eyeH = blinking ? "1px" : `${(style.eyeScale ?? 1) * 17}px`;
  const eyeW = `${(style.eyeScale ?? 1) * 22}px`;
  const browShift = `translateY(${style.browY ?? 0}px)`;
  const eyeColor = style.eyeColor ?? "#9e9e9e";

  function renderMouth(shape: string, o: number) {
    const open = talking ? o : 0;
    switch (shape) {
      case "smile-big":
        return <div style={{ width: 34 + open * 8, height: 13 + open * 10, borderRadius: "0 0 50% 50%", background: open > 0.35 ? "#777777" : "none", borderBottom: "3px solid #777777", borderLeft: "2px solid transparent", borderRight: "2px solid transparent" }} />;
      case "smile-sm":
        return <div style={{ width: 24 + open * 5, height: 9 + open * 8, borderRadius: "0 0 50% 50%", background: open > 0.4 ? "#777777" : "none", borderBottom: "2px solid #777777", borderLeft: "2px solid transparent", borderRight: "2px solid transparent" }} />;
      case "frown":
        return <div style={{ width: 28, height: 11, borderRadius: "50% 50% 0 0", borderTop: "2.5px solid #777777", borderLeft: "2px solid transparent", borderRight: "2px solid transparent" }} />;
      case "frown-big":
        return <div style={{ width: 34, height: 14, borderRadius: "50% 50% 0 0", borderTop: "3px solid #777777", borderLeft: "2px solid transparent", borderRight: "2px solid transparent" }} />;
      case "pout":
        return <div style={{ width: 20, height: 7, borderRadius: "3px", background: "#777777", transform: "translateX(-4px)" }} />;
      case "open-big":
        return <div style={{ width: 28, height: 26, borderRadius: "50%", background: "#313131", border: "2px solid #777777" }} />;
      case "wavy":
        return <div style={{ width: 26, height: 9, borderBottom: "2.5px solid #777777", borderLeft: "2px solid transparent", borderRight: "2px solid transparent", borderRadius: "0 50% 50% 50%" }} />;
      case "flat":
        return <div style={{ width: 24, height: 2, background: "#777777", borderRadius: "2px" }} />;
      default:
        return <div style={{ width: 26, height: 9, borderRadius: "0 0 50% 50%", borderBottom: "2.5px solid #777777", borderLeft: "2px solid transparent", borderRight: "2px solid transparent" }} />;
    }
  }

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-end", justifyContent: "center", pointerEvents: "none" }}>
      {/* Full body */}
      <div style={{
        position: "relative",
        transform: `translateX(${headX * 0.25}px) translateY(${headY * 0.15}px)`,
        transition: "transform 0.12s ease-out",
        marginBottom: -30,
      }}>
        {/* Body / robe — Haohao wears a flowing white/teal robe */}
        <div style={{
          position: "absolute", bottom: 0, left: "50%",
          transform: "translateX(-50%)",
          width: 220, height: 200,
          background: "linear-gradient(175deg, rgba(242,242,242,0.95) 0%, rgba(221,221,221,0.88) 60%, rgba(201,201,201,0.8) 100%)",
          borderRadius: "90px 90px 0 0",
          filter: "drop-shadow(0 12px 35px rgba(0,0,0,0.45))",
        }}>
          {/* Robe collar accent */}
          <div style={{ position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)", width: 55, height: 44, background: "rgba(158,158,158,0.35)", borderRadius: "0 0 28px 28px" }} />
          {/* Sash / teal bow */}
          <div style={{ position: "absolute", top: 50, left: "50%", transform: "translateX(-50%)", width: 70, height: 14, background: "rgba(158,158,158,0.7)", borderRadius: "7px" }} />
        </div>

        {/* Back hair (long, light purple-white) */}
        <div style={{
          position: "absolute", bottom: 125, left: "50%",
          transform: `translateX(-50%) translateX(${headX * 0.7}px) translateY(${headY * 0.7}px) rotate(${style.headTilt ?? 0}deg)`,
          transition: "transform 0.12s ease-out",
          width: 165, height: 240,
          background: "linear-gradient(180deg, #e3e3e3 0%, #bfbfbf 40%, #8b8b8b 100%)",
          borderRadius: "48% 48% 38% 38%",
          zIndex: 1,
        }} />

        {/* Head */}
        <div style={{
          position: "relative", zIndex: 2,
          transform: `translateX(${headX}px) translateY(${headY}px) rotate(${style.headTilt ?? 0}deg)`,
          transition: "transform 0.12s ease-out",
          marginBottom: 95,
        }}>
          {/* Face */}
          <div style={{
            width: 145, height: 158,
            background: "linear-gradient(160deg, #f7f7f7 0%, #ececec 100%)",
            borderRadius: "50% 50% 46% 46%",
            position: "relative",
            boxShadow: "0 10px 35px rgba(0,0,0,0.28), inset 0 -12px 22px rgba(134,134,134,0.08)",
            margin: "0 auto",
          }}>
            {/* Ears */}
            <div style={{ position: "absolute", top: 42, left: -13, width: 25, height: 30, background: "#ececec", borderRadius: "50%", zIndex: -1 }} />
            <div style={{ position: "absolute", top: 42, right: -13, width: 25, height: 30, background: "#ececec", borderRadius: "50%", zIndex: -1 }} />

            {/* Eyes */}
            <div style={{ position: "absolute", top: 54, left: 0, right: 0, display: "flex", justifyContent: "space-around", padding: "0 18px" }}>
              {[0, 1].map((i) => (
                <div key={i} style={{ position: "relative" }}>
                  <div style={{
                    width: eyeW, height: eyeH,
                    background: `linear-gradient(180deg, ${eyeColor} 0%, #656565 100%)`,
                    borderRadius: "50%",
                    transition: "height 0.08s",
                    position: "relative",
                    overflow: "hidden",
                    boxShadow: `0 0 8px ${eyeColor}55, inset 0 2px 4px rgba(0,0,0,0.2)`,
                  }}>
                    <div style={{ position: "absolute", top: 3, left: 5, width: 7, height: 7, background: "rgba(255,255,255,0.9)", borderRadius: "50%" }} />
                    <div style={{ position: "absolute", top: 7, right: 3, width: 3, height: 3, background: "rgba(255,255,255,0.55)", borderRadius: "50%" }} />
                  </div>
                  {/* Eyebrow */}
                  <div style={{
                    position: "absolute", top: -5, left: -3, right: -3, height: 5,
                    background: "#6c6c6c", borderRadius: "4px 4px 0 0",
                    transform: browShift,
                    transition: "transform 0.15s",
                  }} />
                </div>
              ))}
            </div>

            {/* Blush */}
            {style.cheek && (
              <>
                <div style={{ position: "absolute", top: 78, left: 6,  width: 32, height: 14, background: "rgba(182,182,182,0.38)", borderRadius: "50%", filter: "blur(5px)" }} />
                <div style={{ position: "absolute", top: 78, right: 6, width: 32, height: 14, background: "rgba(182,182,182,0.38)", borderRadius: "50%", filter: "blur(5px)" }} />
              </>
            )}

            {/* Nose dot */}
            <div style={{ position: "absolute", top: 90, left: "50%", transform: "translateX(-50%)", width: 5, height: 4, background: "rgba(126,126,126,0.3)", borderRadius: "50%" }} />

            {/* Mouth */}
            <div style={{ position: "absolute", bottom: 26, left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {renderMouth(style.mouthShape ?? "smile-sm", mouthOpen)}
            </div>
          </div>

          {/* Hair top — light purple/lavender */}
          <div style={{
            position: "absolute", top: -30, left: "50%",
            transform: "translateX(-50%)",
            width: 155, height: 95,
            background: "linear-gradient(175deg, #d2d2d2 0%, #aaaaaa 100%)",
            borderRadius: "52% 52% 0 0",
            zIndex: 3,
            overflow: "visible",
          }}>
            {/* Bangs */}
            <div style={{ position: "absolute", top: 46, left: -10, width: 48, height: 62, background: "#bfbfbf", borderRadius: "0 0 50% 30%", transform: "rotate(-6deg)" }} />
            <div style={{ position: "absolute", top: 56, left: 15,  width: 36, height: 72, background: "#b4b4b4", borderRadius: "0 0 60% 40%", transform: "rotate(-2deg)" }} />
            <div style={{ position: "absolute", top: 60, left: 38,  width: 32, height: 66, background: "#bfbfbf", borderRadius: "0 0 50% 50%", transform: "rotate(2deg)" }} />
            <div style={{ position: "absolute", top: 48, right: -10, width: 48, height: 62, background: "#bfbfbf", borderRadius: "0 0 30% 50%", transform: "rotate(6deg)" }} />
            <div style={{ position: "absolute", top: 56, right: 14,  width: 36, height: 60, background: "#b4b4b4", borderRadius: "0 0 40% 60%", transform: "rotate(-2deg)" }} />
          </div>

          {/* Side hair strands */}
          <div style={{ position: "absolute", top: 22, left: -32, zIndex: 3, width: 36, height: 140, background: "linear-gradient(180deg, #bfbfbf, #8b8b8b)", borderRadius: "50% 30% 40% 50%", transform: "rotate(-4deg)" }} />
          <div style={{ position: "absolute", top: 22, right: -32, zIndex: 3, width: 36, height: 140, background: "linear-gradient(180deg, #bfbfbf, #8b8b8b)", borderRadius: "30% 50% 50% 40%", transform: "rotate(4deg)" }} />

          {/* Hair ornament — teal/gold pin on the side */}
          <div style={{ position: "absolute", top: 5, right: 8, zIndex: 5 }}>
            <div style={{ width: 16, height: 16, borderRadius: "50%", background: "radial-gradient(circle, #bababa 0%, #818181 100%)", boxShadow: "0 0 8px #3abba8aa" }} />
            <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: 6, height: 6, borderRadius: "50%", background: "#f3f3f3" }} />
          </div>

          {/* Small bun/hair piece on top */}
          <div style={{ position: "absolute", top: -50, left: "50%", transform: "translateX(-50%)", zIndex: 4, width: 50, height: 40, background: "linear-gradient(175deg, #e3e3e3, #b4b4b4)", borderRadius: "50%", boxShadow: "0 -3px 12px rgba(164,164,164,0.4)" }} />
          <div style={{ position: "absolute", top: -44, left: "50%", transform: "translateX(-50%)", zIndex: 5, width: 14, height: 20, background: "linear-gradient(180deg, #bababa, #818181)", borderRadius: "50%", boxShadow: "0 0 8px #9e9e9e" }} />
        </div>
      </div>
    </div>
  );
}
