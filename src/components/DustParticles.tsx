import { memo, useEffect, useRef } from "react";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  alphaSpeed: number;
  life: number;
  maxLife: number;
  hue: number;
}

function DustParticles() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const particlesRef = useRef<Particle[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Sprite glow dibuat sekali; menggantikan shadowBlur per partikel (jauh lebih ringan di GPU/CPU).
    const sprite = document.createElement("canvas");
    sprite.width = sprite.height = 32;
    const sctx = sprite.getContext("2d")!;
    const grad = sctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0,    "hsla(0, 0%, 85%, 1)");
    grad.addColorStop(0.25, "hsla(0, 0%, 85%, 0.9)");
    grad.addColorStop(0.45, "hsla(0, 0%, 80%, 0.3)");
    grad.addColorStop(1,    "hsla(0, 0%, 80%, 0)");
    sctx.fillStyle = grad;
    sctx.fillRect(0, 0, 32, 32);

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);

    function spawnParticle(): Particle {
      const maxLife = 180 + Math.random() * 300;
      return {
        x: Math.random() * canvas!.width,
        y: canvas!.height * 0.2 + Math.random() * canvas!.height * 0.7,
        vx: (Math.random() - 0.5) * 0.3,
        vy: -0.15 - Math.random() * 0.35,
        size: 0.8 + Math.random() * 1.8,
        alpha: 0,
        alphaSpeed: 0.008 + Math.random() * 0.008,
        life: 0,
        maxLife,
        hue: 330 + Math.random() * 30,
      };
    }

    for (let i = 0; i < 60; i++) {
      const p = spawnParticle();
      p.life = Math.random() * p.maxLife;
      p.alpha = Math.random() * 0.45;
      particlesRef.current.push(p);
    }

    function animate() {
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);

      if (particlesRef.current.length < 80 && Math.random() < 0.3) {
        particlesRef.current.push(spawnParticle());
      }

      particlesRef.current = particlesRef.current.filter((p) => {
        p.life += 1;
        p.x += p.vx + Math.sin(p.life * 0.03) * 0.12;
        p.y += p.vy;

        const progress = p.life / p.maxLife;
        if (progress < 0.15) {
          p.alpha = (progress / 0.15) * 0.5;
        } else if (progress > 0.75) {
          p.alpha = ((1 - progress) / 0.25) * 0.5;
        } else {
          p.alpha = 0.3 + Math.sin(p.life * 0.05) * 0.15;
        }

        const d = (p.size + 4) * 2;
        ctx!.globalAlpha = Math.max(0, Math.min(1, p.alpha));
        ctx!.drawImage(sprite, p.x - d / 2, p.y - d / 2, d, d);

        return p.life < p.maxLife && p.y > -20;
      });

      ctx!.globalAlpha = 1;
      animRef.current = requestAnimationFrame(animate);
    }

    animate();

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="scene-particles"
      style={{ opacity: 0.7 }}
    />
  );
}

export default memo(DustParticles);
