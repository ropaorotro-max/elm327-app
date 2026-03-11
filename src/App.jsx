import { useState, useEffect, useRef, useCallback } from "react";

// ============================================================
//  AFR CALCULATION ENGINE
// ============================================================

const FUEL_PROFILES = {
  gasoline: { name: "Gasoline (E0)",  stoich: 14.7,  color: "#007aff" },
  e10:      { name: "E10 (90%+10%)", stoich: 14.1,  color: "#30d158" },
  e20:      { name: "E20",            stoich: 13.7,  color: "#34c759" },
  e85:      { name: "E85 Flex Fuel",  stoich: 9.75,  color: "#ffd60a" },
  ethanol:  { name: "Ethanol E100",   stoich: 9.0,   color: "#ff9f0a" },
  diesel:   { name: "Diesel",         stoich: 14.5,  color: "#ff6b35" },
  lpg:      { name: "LPG / Autogas",  stoich: 15.7,  color: "#bf5af2" },
  cng:      { name: "CNG",            stoich: 17.2,  color: "#64d2ff" },
};

/**
 * Estimate AFR from OBD-II PIDs
 *
 * Primary: Fuel Trim method
 *   totalTrim = STFT + LTFT (%)
 *   Lambda    = 1 / (1 + totalTrim/100)
 *   AFR       = Lambda * stoich
 *
 * Blend: O2 narrow-band voltage (0.1–0.9 V)
 *   0.45 V = stoich crossover
 *   deviation mapped ±0.3 lambda
 */
function calcAFR({ o2V, stft, ltft, maf, load, fuelType }) {
  const stoich = FUEL_PROFILES[fuelType].stoich;
  let lambda = 1.0;
  let method = "Default";

  if (stft !== undefined && ltft !== undefined) {
    const totalTrim = (stft + ltft) / 100;
    lambda = 1.0 / (1.0 + totalTrim);
    method = "Fuel Trim (STFT+LTFT)";
  }

  if (o2V !== undefined && o2V >= 0.05 && o2V <= 0.95) {
    const o2Lambda = 1.0 + (0.45 - o2V) * 0.3;
    lambda = (lambda + o2Lambda) / 2;
    method = "Fuel Trim + O2 Sensor";
  }

  if (!stft && maf > 0 && load > 0) {
    lambda = 0.85 + (load / 100) * 0.4;
    method = "MAF + Load";
  }

  const afr = Math.max(9.0, Math.min(22.0, lambda * stoich));
  return { afr, lambda: afr / stoich, stoich, method };
}

function getAFRStatus(lambda) {
  const d = lambda - 1.0;
  if (Math.abs(d) < 0.02)  return { label: "STOICH ✓",      color: "#30d158", bg: "rgba(48,209,88,0.12)",   desc: "เผาไหม้สมบูรณ์แบบ — Catalyst ทำงานดีที่สุด" };
  if (d >  0.15)            return { label: "LEAN ⚠",        color: "#ff3b30", bg: "rgba(255,59,48,0.12)",   desc: "บางมาก — เครื่องร้อนเกิน / เสียหายได้" };
  if (d >  0.05)            return { label: "SLIGHTLY LEAN", color: "#ff9f0a", bg: "rgba(255,159,10,0.12)",  desc: "บางเล็กน้อย — ประหยัดน้ำมัน แต่กำลังลดลง" };
  if (d < -0.15)            return { label: "RICH ⚠",        color: "#ff3b30", bg: "rgba(255,59,48,0.12)",   desc: "หนามาก — สิ้นเปลือง / คาร์บอนสะสม / ควันดำ" };
  if (d < -0.05)            return { label: "SLIGHTLY RICH", color: "#ff9f0a", bg: "rgba(255,159,10,0.12)",  desc: "หนาเล็กน้อย — กำลังดี แต่สิ้นเปลืองกว่า" };
  return                           { label: "NORMAL",         color: "#30d158", bg: "rgba(48,209,88,0.12)",   desc: "อยู่ในเกณฑ์ปกติ" };
}

// ============================================================
//  SIMULATED OBD DATA
// ============================================================
function generateFakeData(prev) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const jitter = (x, scale) => x + (Math.random() - 0.5) * scale;
  return {
    rpm:       clamp(jitter(prev?.rpm       ?? 1200, 300),  700,  7000),
    speed:     clamp(jitter(prev?.speed     ?? 60,    8),   0,    200),
    coolant:   clamp(jitter(prev?.coolant   ?? 88,   0.5),  70,   110),
    throttle:  clamp(jitter(prev?.throttle  ?? 20,    5),   0,    100),
    load:      clamp(jitter(prev?.load      ?? 35,    4),   10,   100),
    fuel:      clamp((prev?.fuel ?? 72) - 0.005,          0,    100),
    voltage:   +(12.1 + Math.random() * 0.5).toFixed(2),
    intakeTemp:clamp(jitter(prev?.intakeTemp ?? 32,  0.3),  20,    60),
    stft:      clamp(jitter(prev?.stft      ?? 2,    3),   -25,   25),
    ltft:      clamp(jitter(prev?.ltft      ?? 1,   0.5),  -20,   20),
    o2V:       clamp(jitter(prev?.o2V       ?? 0.45,0.08),0.05, 0.95),
    maf:       clamp(jitter(prev?.maf       ?? 15,   2),    1,   300),
  };
}

// ============================================================
//  UI COMPONENTS
// ============================================================
function GaugeArc({ value, min, max, label, unit, color, size = 160, warningAt, dangerAt, decimals = 0 }) {
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const r = size / 2 - 14;
  const cx = size / 2, cy = size / 2;
  const toRad = d => (d * Math.PI) / 180;
  const arc = (s, e) => {
    const [x1, y1] = [cx + r * Math.cos(toRad(s - 90)), cy + r * Math.sin(toRad(s - 90))];
    const [x2, y2] = [cx + r * Math.cos(toRad(e - 90)), cy + r * Math.sin(toRad(e - 90))];
    return `M ${x1} ${y1} A ${r} ${r} 0 ${e - s > 180 ? 1 : 0} 1 ${x2} ${y2}`;
  };
  const angle = -135 + pct * 270;
  const nx = cx + (r - 10) * Math.cos(toRad(angle - 90));
  const ny = cy + (r - 10) * Math.sin(toRad(angle - 90));
  const ac = (dangerAt && value >= dangerAt) ? "#ff3b30" : (warningAt && value >= warningAt) ? "#ff9f0a" : color;
  return (
    <svg width={size} height={size} style={{ overflow: "visible" }}>
      <path d={arc(-135, 135)} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={8} strokeLinecap="round" />
      <path d={arc(-135, -135 + pct * 270)} fill="none" stroke={ac} strokeWidth={8} strokeLinecap="round"
        style={{ filter: `drop-shadow(0 0 6px ${ac}88)`, transition: "all 0.35s ease" }} />
      <circle cx={nx} cy={ny} r={4} fill={ac} style={{ filter: `drop-shadow(0 0 4px ${ac})`, transition: "all 0.35s ease" }} />
      <circle cx={cx} cy={cy} r={6} fill={ac} opacity={0.9} />
      <text x={cx} y={cy + 22} textAnchor="middle" fill="white" fontSize={size < 130 ? 18 : 24}
        fontFamily="'Orbitron',monospace" fontWeight="700" style={{ transition: "all 0.3s" }}>
        {decimals > 0 ? value.toFixed(decimals) : Math.round(value)}
      </text>
      <text x={cx} y={cy + 37} textAnchor="middle" fill="rgba(255,255,255,0.45)" fontSize={10} fontFamily="'Orbitron',monospace">{unit}</text>
      <text x={cx} y={cy - 26} textAnchor="middle" fill="rgba(255,255,255,0.5)" fontSize={9} fontFamily="'Space Grotesk',sans-serif" letterSpacing="0.08em">{label.toUpperCase()}</text>
    </svg>
  );
}

function BarGauge({ label, value, min, max, unit, color, warningAt, dangerAt, decimals = 1 }) {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  const ac = (dangerAt && value >= dangerAt) ? "#ff3b30" : (warningAt && value >= warningAt) ? "#ff9f0a" : color;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
        <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 11, color: "rgba(255,255,255,0.5)", letterSpacing: "0.1em" }}>{label.toUpperCase()}</span>
        <span style={{ fontFamily: "'Orbitron',monospace", fontSize: 12, color: ac, fontWeight: 700 }}>{value.toFixed(decimals)}{unit}</span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, borderRadius: 3, background: `linear-gradient(90deg,${ac}88,${ac})`, boxShadow: `0 0 8px ${ac}66`, transition: "width 0.4s ease, background 0.3s" }} />
      </div>
    </div>
  );
}

function StatusDot({ connected }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: connected ? "#30d158" : "#ff3b30", boxShadow: connected ? "0 0 8px #30d158" : "0 0 8px #ff3b30", animation: connected ? "pulse 2s infinite" : "none", display: "inline-block" }} />
      <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 11, color: connected ? "#30d158" : "#ff3b30", letterSpacing: "0.1em" }}>{connected ? "CONNECTED" : "DISCONNECTED"}</span>
    </span>
  );
}

function DTCBadge({ code, desc }) {
  return (
    <div style={{ background: "rgba(255,59,48,0.12)", border: "1px solid rgba(255,59,48,0.3)", borderRadius: 8, padding: "8px 12px", display: "flex", gap: 10, alignItems: "center" }}>
      <span style={{ fontFamily: "'Orbitron',monospace", fontSize: 12, color: "#ff3b30", fontWeight: 700 }}>{code}</span>
      <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 12, color: "rgba(255,255,255,0.6)" }}>{desc}</span>
    </div>
  );
}

// AFR Spectrum Bar
function AFRMeter({ afr, lambda, stoich, status }) {
  const minA = stoich - 4, maxA = stoich + 5;
  const pct = Math.max(0, Math.min(100, ((afr - minA) / (maxA - minA)) * 100));
  const stoichPct = ((stoich - minA) / (maxA - minA)) * 100;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ position: "relative", height: 22, borderRadius: 11, background: "linear-gradient(90deg,#ff3b30 0%,#ff9f0a 28%,#30d158 46%,#30d158 54%,#ff9f0a 72%,#007aff 100%)", marginBottom: 8 }}>
        <div style={{ position: "absolute", left: `${stoichPct}%`, top: -5, transform: "translateX(-50%)", width: 2, height: 32, background: "rgba(255,255,255,0.9)", borderRadius: 1 }} />
        <div style={{ position: "absolute", left: `${pct}%`, top: "50%", transform: "translate(-50%,-50%)", width: 18, height: 18, borderRadius: "50%", background: status.color, border: "2.5px solid white", boxShadow: `0 0 14px ${status.color}`, transition: "left 0.4s ease" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "rgba(255,255,255,0.3)", fontFamily: "'Orbitron',monospace" }}>
        <span>← RICH</span>
        <span style={{ color: "rgba(255,255,255,0.5)" }}>λ {lambda.toFixed(3)}  |  AFR {afr.toFixed(2)} : 1</span>
        <span>LEAN →</span>
      </div>
    </div>
  );
}

// Lambda Arc
function LambdaRing({ lambda, color, size = 110 }) {
  const pct = Math.max(0, Math.min(1, (lambda - 0.7) / 0.8));
  const r = size / 2 - 10, cx = size / 2, cy = size / 2;
  const toRad = d => (d * Math.PI) / 180;
  const arc = (s, e) => {
    const [x1, y1] = [cx + r * Math.cos(toRad(s - 90)), cy + r * Math.sin(toRad(s - 90))];
    const [x2, y2] = [cx + r * Math.cos(toRad(e - 90)), cy + r * Math.sin(toRad(e - 90))];
    return `M ${x1} ${y1} A ${r} ${r} 0 ${e - s > 180 ? 1 : 0} 1 ${x2} ${y2}`;
  };
  return (
    <svg width={size} height={size}>
      <path d={arc(-135, 135)} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={7} strokeLinecap="round" />
      <path d={arc(-135, -135 + pct * 270)} fill="none" stroke={color} strokeWidth={7} strokeLinecap="round"
        style={{ filter: `drop-shadow(0 0 6px ${color}88)`, transition: "all 0.4s" }} />
      <text x={cx} y={cy + 6} textAnchor="middle" fill="white" fontSize={17} fontFamily="'Orbitron',monospace" fontWeight="700">{lambda.toFixed(3)}</text>
      <text x={cx} y={cy + 20} textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize={8} fontFamily="'Orbitron',monospace">LAMBDA λ</text>
    </svg>
  );
}

const DEMO_DTCS = [{ code: "P0420", desc: "Catalyst System Efficiency Below Threshold" }];

// ============================================================
//  MAIN APP
// ============================================================
export default function App() {
  const [connected, setConnected] = useState(false);
  const [data, setData]           = useState(null);
  const [tab, setTab]             = useState("gauge");
  const [port, setPort]           = useState("AUTO");
  const [showDTC, setShowDTC]     = useState(false);
  const [fuelType, setFuelType]   = useState("gasoline");
  const intervalRef = useRef(null);

  const connect    = useCallback(() => { setConnected(true); setData(generateFakeData(null)); }, []);
  const disconnect = useCallback(() => { setConnected(false); clearInterval(intervalRef.current); }, []);

  useEffect(() => {
    if (connected) {
      intervalRef.current = setInterval(() => setData(prev => generateFakeData(prev)), 800);
    }
    return () => clearInterval(intervalRef.current);
  }, [connected]);

  const afrData  = data ? calcAFR({ o2V: data.o2V, stft: data.stft, ltft: data.ltft, maf: data.maf, load: data.load, fuelType }) : null;
  const afrStatus = afrData ? getAFRStatus(afrData.lambda) : null;
  const profile   = FUEL_PROFILES[fuelType];
  const tabs      = ["gauge", "afr", "sensors", "dtc"];

  const card = (children, extra = {}) => (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20, ...extra }}>
      {children}
    </div>
  );

  const sectionLabel = txt => (
    <div style={{ fontFamily: "'Orbitron',monospace", fontSize: 10, color: "rgba(255,255,255,0.4)", letterSpacing: "0.12em", marginBottom: 14 }}>{txt}</div>
  );

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Space+Grotesk:wght@300;400;500;600&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        body{background:#080c12;}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        ::-webkit-scrollbar{width:4px;}
        ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.15);border-radius:2px;}
      `}</style>

      <div style={{ minHeight: "100vh", background: "#080c12", color: "white", fontFamily: "'Space Grotesk',sans-serif",
        backgroundImage: "radial-gradient(ellipse at 20% 20%,rgba(0,180,255,0.04) 0%,transparent 60%),radial-gradient(ellipse at 80% 80%,rgba(255,60,0,0.04) 0%,transparent 60%)" }}>

        {/* ── Header ── */}
        <div style={{ padding: "16px 24px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(255,255,255,0.02)", backdropFilter: "blur(10px)", position: "sticky", top: 0, zIndex: 100 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg,#007aff,#00d2ff)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, boxShadow: "0 0 16px rgba(0,122,255,0.4)" }}>⚡</div>
            <div>
              <div style={{ fontFamily: "'Orbitron',monospace", fontSize: 14, fontWeight: 700, letterSpacing: "0.12em" }}>OBD-II DASH</div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", letterSpacing: "0.1em" }}>ELM327 · AFR ANALYZER</div>
            </div>
          </div>
          <StatusDot connected={connected} />
        </div>

        <div style={{ maxWidth: 720, margin: "0 auto", padding: "20px 16px" }}>

          {/* ── Fuel Selector ── */}
          <div style={{ marginBottom: 16, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: "14px 16px" }}>
            <div style={{ fontFamily: "'Orbitron',monospace", fontSize: 10, color: "rgba(255,255,255,0.4)", letterSpacing: "0.12em", marginBottom: 10 }}>⛽ FUEL TYPE</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {Object.entries(FUEL_PROFILES).map(([k, p]) => (
                <button key={k} onClick={() => setFuelType(k)} style={{
                  padding: "5px 12px", borderRadius: 8, border: "1px solid",
                  borderColor: fuelType === k ? p.color : "rgba(255,255,255,0.1)",
                  background: fuelType === k ? `${p.color}22` : "transparent",
                  color: fuelType === k ? p.color : "rgba(255,255,255,0.45)",
                  fontFamily: "'Space Grotesk',sans-serif", fontSize: 11, cursor: "pointer", transition: "all 0.2s", fontWeight: fuelType === k ? 600 : 400
                }}>{p.name}</button>
              ))}
            </div>
            <div style={{ marginTop: 10, fontSize: 11, color: "rgba(255,255,255,0.35)", display: "flex", gap: 20 }}>
              <span>Stoich: <span style={{ color: profile.color, fontFamily: "'Orbitron',monospace", fontWeight: 700 }}>{profile.stoich.toFixed(2)} : 1</span></span>
              {afrData && <span>Current AFR: <span style={{ color: afrStatus.color, fontFamily: "'Orbitron',monospace", fontWeight: 700 }}>{afrData.afr.toFixed(2)}</span></span>}
              {afrData && <span>λ: <span style={{ color: afrStatus.color, fontFamily: "'Orbitron',monospace", fontWeight: 700 }}>{afrData.lambda.toFixed(3)}</span></span>}
            </div>
          </div>

          {/* ── Connect Panel ── */}
          {!connected && (
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: 24, marginBottom: 20, animation: "fadeIn 0.4s ease" }}>
              <div style={{ fontFamily: "'Orbitron',monospace", fontSize: 13, marginBottom: 16, color: "rgba(255,255,255,0.7)", letterSpacing: "0.1em" }}>CONNECT TO ELM327</div>
              <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
                {["AUTO", "COM3", "/dev/ttyUSB0", "/dev/rfcomm0"].map(p => (
                  <button key={p} onClick={() => setPort(p)} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid", borderColor: port === p ? "#007aff" : "rgba(255,255,255,0.12)", background: port === p ? "rgba(0,122,255,0.15)" : "transparent", color: port === p ? "#007aff" : "rgba(255,255,255,0.5)", fontFamily: "'Orbitron',monospace", fontSize: 10, cursor: "pointer", letterSpacing: "0.06em", transition: "all 0.2s" }}>{p}</button>
                ))}
              </div>
              <button onClick={connect} style={{ width: "100%", padding: 14, borderRadius: 12, border: "none", background: "linear-gradient(135deg,#007aff,#00d2ff)", color: "white", fontFamily: "'Orbitron',monospace", fontSize: 13, fontWeight: 700, letterSpacing: "0.12em", cursor: "pointer", boxShadow: "0 4px 20px rgba(0,122,255,0.35)", transition: "transform 0.15s,box-shadow 0.15s" }}
                onMouseEnter={e => { e.target.style.transform = "translateY(-1px)"; e.target.style.boxShadow = "0 6px 28px rgba(0,122,255,0.5)"; }}
                onMouseLeave={e => { e.target.style.transform = ""; e.target.style.boxShadow = "0 4px 20px rgba(0,122,255,0.35)"; }}>
                CONNECT
              </button>
              <p style={{ marginTop: 12, fontSize: 11, color: "rgba(255,255,255,0.25)", textAlign: "center" }}>* Using simulated data — replace with real serial/WebSocket</p>
            </div>
          )}

          {/* ── Connected ── */}
          {connected && (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
                <div style={{ display: "flex", gap: 4, background: "rgba(255,255,255,0.04)", borderRadius: 10, padding: 4 }}>
                  {tabs.map(t => (
                    <button key={t} onClick={() => setTab(t)} style={{ padding: "7px 14px", borderRadius: 7, border: "none", background: tab === t ? "rgba(255,255,255,0.1)" : "transparent", color: tab === t ? "white" : "rgba(255,255,255,0.4)", fontFamily: "'Orbitron',monospace", fontSize: 10, letterSpacing: "0.08em", cursor: "pointer", transition: "all 0.2s" }}>{t.toUpperCase()}</button>
                  ))}
                </div>
                <button onClick={disconnect} style={{ padding: "7px 16px", borderRadius: 8, border: "1px solid rgba(255,59,48,0.3)", background: "rgba(255,59,48,0.08)", color: "#ff3b30", fontFamily: "'Orbitron',monospace", fontSize: 10, cursor: "pointer", letterSpacing: "0.08em" }}>DISCONNECT</button>
              </div>

              {/* ── GAUGE TAB ── */}
              {tab === "gauge" && data && (
                <div style={{ animation: "fadeIn 0.35s ease" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                    {[
                      { v: data.rpm,   min: 0, max: 8000, label: "Engine", unit: "RPM",  color: "#007aff", warn: 5500, danger: 7000, size: 180 },
                      { v: data.speed, min: 0, max: 220,  label: "Speed",  unit: "km/h", color: "#30d158", warn: 140,  danger: 180,  size: 180 },
                    ].map(({ v, min, max, label, unit, color, warn, danger, size }) => (
                      <div key={label} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: "20px 10px", display: "flex", flexDirection: "column", alignItems: "center" }}>
                        <GaugeArc value={v} min={min} max={max} label={label} unit={unit} color={color} warningAt={warn} dangerAt={danger} size={size} />
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
                    {[
                      { v: data.coolant,  min: 50, max: 120, label: "Coolant",  unit: "°C", color: "#ff9f0a", warn: 100, danger: 110 },
                      { v: data.throttle, min: 0,  max: 100, label: "Throttle", unit: "%",  color: "#bf5af2", warn: 85 },
                      { v: data.load,     min: 0,  max: 100, label: "Load",     unit: "%",  color: "#ff6b35", warn: 80, danger: 95 },
                    ].map(({ v, min, max, label, unit, color, warn, danger }) => (
                      <div key={label} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: "14px 6px", display: "flex", flexDirection: "column", alignItems: "center" }}>
                        <GaugeArc value={v} min={min} max={max} label={label} unit={unit} color={color} warningAt={warn} dangerAt={danger} size={120} />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── AFR TAB ── */}
              {tab === "afr" && data && afrData && (
                <div style={{ animation: "fadeIn 0.35s ease", display: "flex", flexDirection: "column", gap: 12 }}>

                  {/* Status Banner */}
                  <div style={{ background: afrStatus.bg, border: `1px solid ${afrStatus.color}44`, borderRadius: 16, padding: "16px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                    <div>
                      <div style={{ fontFamily: "'Orbitron',monospace", fontSize: 20, fontWeight: 900, color: afrStatus.color, letterSpacing: "0.1em", marginBottom: 4 }}>{afrStatus.label}</div>
                      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)" }}>{afrStatus.desc}</div>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 4, fontFamily: "'Orbitron',monospace" }}>METHOD: {afrData.method}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontFamily: "'Orbitron',monospace", fontSize: 32, fontWeight: 900, color: "white", lineHeight: 1 }}>{afrData.afr.toFixed(2)}</div>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", marginTop: 4 }}>AIR : FUEL</div>
                    </div>
                  </div>

                  {/* Spectrum */}
                  {card(<>
                    {sectionLabel("AFR SPECTRUM")}
                    <AFRMeter afr={afrData.afr} lambda={afrData.lambda} stoich={afrData.stoich} status={afrStatus} />
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-around", marginTop: 20 }}>
                      <LambdaRing lambda={afrData.lambda} color={afrStatus.color} size={110} />
                      <div style={{ flex: 1, paddingLeft: 24 }}>
                        {[
                          { l: "STOICH TARGET",   v: `${afrData.stoich.toFixed(2)} : 1`,  c: profile.color },
                          { l: "CURRENT AFR",     v: `${afrData.afr.toFixed(2)} : 1`,     c: afrStatus.color },
                          { l: "LAMBDA λ",        v: afrData.lambda.toFixed(4),            c: afrStatus.color },
                          { l: "DEVIATION",       v: `${((afrData.lambda - 1) * 100).toFixed(2)}%`, c: Math.abs(afrData.lambda - 1) > 0.05 ? "#ff9f0a" : "#30d158" },
                        ].map(({ l, v, c }) => (
                          <div key={l} style={{ marginBottom: 10 }}>
                            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", fontFamily: "'Orbitron',monospace", marginBottom: 2 }}>{l}</div>
                            <div style={{ fontFamily: "'Orbitron',monospace", fontSize: 16, fontWeight: 700, color: c }}>{v}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>)}

                  {/* Fuel Trim Panel */}
                  {card(<>
                    {sectionLabel("FUEL TRIM ANALYSIS")}
                    <BarGauge label="Short Term Fuel Trim (STFT)" value={data.stft} min={-25} max={25} unit="%" color="#64d2ff" warningAt={15} dangerAt={22} />
                    <BarGauge label="Long Term Fuel Trim (LTFT)"  value={data.ltft} min={-20} max={20} unit="%" color="#bf5af2" warningAt={12} dangerAt={18} />
                    <BarGauge label="O2 Sensor Voltage"           value={data.o2V}  min={0}   max={1}  unit=" V"  color="#ff9f0a" decimals={3} />
                    <BarGauge label="MAF Airflow"                 value={data.maf}  min={0}   max={300} unit=" g/s" color="#30d158" />
                    <div style={{ marginTop: 14, padding: "12px 14px", background: "rgba(0,0,0,0.2)", borderRadius: 10, fontSize: 11, lineHeight: 1.8, color: "rgba(255,255,255,0.55)" }}>
                      <div style={{ color: data.stft > 10 ? "#ff9f0a" : data.stft < -10 ? "#ff3b30" : "#30d158", fontWeight: 600 }}>
                        {data.stft > 10  ? "⚠ STFT สูง — ECU เติมน้ำมันเพิ่ม (ส่วนผสมเบาบาง)" :
                         data.stft < -10 ? "⚠ STFT ต่ำ — ECU ลดน้ำมัน (ส่วนผสมหนาเกิน)" :
                                           "✓ STFT ปกติ — ECU ปรับได้ดี"}
                      </div>
                      <div style={{ color: Math.abs(data.ltft) > 10 ? "#ff9f0a" : "#30d158", fontWeight: 600 }}>
                        {Math.abs(data.ltft) > 10 ? `⚠ LTFT ${data.ltft > 0 ? "บวก" : "ลบ"} — ปัญหาเรื้อรัง ควรตรวจเพิ่มเติม` : "✓ LTFT อยู่ในเกณฑ์ปกติ"}
                      </div>
                      <div style={{ color: data.o2V > 0.7 ? "#ff9f0a" : data.o2V < 0.2 ? "#007aff" : "#30d158", fontWeight: 600 }}>
                        {data.o2V > 0.7 ? "⚠ O2 Voltage สูง — ส่วนผสมหนา (Rich)" :
                         data.o2V < 0.2 ? "⚠ O2 Voltage ต่ำ — ส่วนผสมบาง (Lean)" :
                                          "✓ O2 Sensor อยู่ในช่วงสวิตชิ่งปกติ"}
                      </div>
                    </div>
                  </>)}

                  {/* AFR Reference Table */}
                  {card(<>
                    {sectionLabel(`AFR REFERENCE — ${profile.name.toUpperCase()}`)}
                    {[
                      { range: `${(profile.stoich * 0.88).toFixed(2)}–${(profile.stoich * 0.94).toFixed(2)}`, label: "Max Power (WOT)",    color: "#ff6b35", desc: "กำลังสูงสุด — เหมาะกับการเร่งเต็มที่" },
                      { range: `${(profile.stoich * 0.95).toFixed(2)}–${(profile.stoich * 0.98).toFixed(2)}`, label: "Power / Torque",     color: "#ff9f0a", desc: "กำลัง/แรงบิดดี — ขับสปอร์ต" },
                      { range: `${(profile.stoich * 0.99).toFixed(2)}–${(profile.stoich * 1.01).toFixed(2)}`, label: "Stoichiometric ✓",   color: "#30d158", desc: "เผาไหม้สมบูรณ์ — Catalyst ทำงานดีที่สุด" },
                      { range: `${(profile.stoich * 1.03).toFixed(2)}–${(profile.stoich * 1.08).toFixed(2)}`, label: "Lean Cruise",        color: "#007aff", desc: "ประหยัดน้ำมัน — ขับทางไกลความเร็วคงที่" },
                      { range: `< ${(profile.stoich * 0.88).toFixed(2)}`,                                     label: "Danger Rich ⚠",     color: "#ff3b30", desc: "อันตราย — เสียหาย / คาร์บอนสะสม" },
                      { range: `> ${(profile.stoich * 1.15).toFixed(2)}`,                                     label: "Danger Lean ⚠",     color: "#ff3b30", desc: "อันตราย — เครื่องร้อนเกิน / backfire" },
                    ].map(row => (
                      <div key={row.label} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                        <div style={{ width: 6, height: 6, borderRadius: "50%", background: row.color, flexShrink: 0, boxShadow: `0 0 6px ${row.color}` }} />
                        <div style={{ fontFamily: "'Orbitron',monospace", fontSize: 11, color: row.color, width: 78, flexShrink: 0 }}>{row.range}</div>
                        <div>
                          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.85)", fontWeight: 600 }}>{row.label}</div>
                          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{row.desc}</div>
                        </div>
                      </div>
                    ))}
                    <div style={{ marginTop: 14, padding: "10px 14px", background: "rgba(255,255,255,0.03)", borderRadius: 10, fontSize: 10, color: "rgba(255,255,255,0.35)", lineHeight: 1.7 }}>
                      <b style={{ color: "rgba(255,255,255,0.5)" }}>สูตรคำนวณ:</b><br />
                      λ = 1 / (1 + (STFT + LTFT) / 100)  · เฉลี่ยกับ O2 Voltage<br />
                      AFR = λ × Stoichiometric({profile.stoich})
                    </div>
                  </>)}
                </div>
              )}

              {/* ── SENSORS TAB ── */}
              {tab === "sensors" && data && (
                <div style={{ animation: "fadeIn 0.35s ease" }}>
                  {card(<>
                    <div style={{ marginBottom: 20 }}>
                      {sectionLabel("ENGINE")}
                      <BarGauge label="RPM"           value={data.rpm}       min={0}   max={8000} unit=""     color="#007aff" warningAt={5500} dangerAt={7000} decimals={0} />
                      <BarGauge label="Engine Load"   value={data.load}      min={0}   max={100}  unit="%"    color="#ff6b35" warningAt={80}   dangerAt={95} />
                      <BarGauge label="Coolant Temp"  value={data.coolant}   min={50}  max={120}  unit="°C"   color="#ff9f0a" warningAt={100}  dangerAt={110} />
                      <BarGauge label="Intake Temp"   value={data.intakeTemp}min={10}  max={70}   unit="°C"   color="#64d2ff" />
                      <BarGauge label="MAF Airflow"   value={data.maf}       min={0}   max={300}  unit=" g/s" color="#30d158" />
                    </div>
                    <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 20, marginBottom: 20 }}>
                      {sectionLabel("VEHICLE")}
                      <BarGauge label="Speed"             value={data.speed}    min={0}  max={220} unit=" km/h" color="#30d158" warningAt={140} dangerAt={180} decimals={0} />
                      <BarGauge label="Throttle Position" value={data.throttle} min={0}  max={100} unit="%"     color="#bf5af2" warningAt={85} />
                      <BarGauge label="Fuel Level"        value={data.fuel}     min={0}  max={100} unit="%"     color="#ffd60a" warningAt={20}  dangerAt={10} />
                    </div>
                    <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 20 }}>
                      {sectionLabel("FUEL & ELECTRICAL")}
                      <BarGauge label="Battery Voltage" value={data.voltage} min={11} max={15}  unit=" V"  color="#30d158" warningAt={12.2} dangerAt={11.8} decimals={2} />
                      <BarGauge label="O2 Sensor"       value={data.o2V}    min={0}  max={1}   unit=" V"  color="#ff9f0a" decimals={3} />
                      <BarGauge label="STFT"            value={data.stft}   min={-25} max={25} unit="%"   color="#64d2ff" warningAt={15} dangerAt={22} />
                      <BarGauge label="LTFT"            value={data.ltft}   min={-20} max={20} unit="%"   color="#bf5af2" warningAt={12} dangerAt={18} />
                    </div>
                  </>)}
                </div>
              )}

              {/* ── DTC TAB ── */}
              {tab === "dtc" && (
                <div style={{ animation: "fadeIn 0.35s ease", display: "flex", flexDirection: "column", gap: 12 }}>
                  {card(<>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                      {sectionLabel("TROUBLE CODES")}
                      <button onClick={() => setShowDTC(p => !p)} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)", background: "transparent", color: "rgba(255,255,255,0.6)", fontFamily: "'Orbitron',monospace", fontSize: 10, cursor: "pointer", letterSpacing: "0.06em", marginTop: -14 }}>{showDTC ? "HIDE" : "SCAN"}</button>
                    </div>
                    {showDTC ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {DEMO_DTCS.map(d => <DTCBadge key={d.code} {...d} />)}
                      </div>
                    ) : (
                      <div style={{ textAlign: "center", padding: "30px 0", color: "rgba(255,255,255,0.25)", fontSize: 12 }}>กด SCAN เพื่อตรวจสอบรหัสข้อผิดพลาด</div>
                    )}
                  </>)}
                  {showDTC && (
                    <button style={{ width: "100%", padding: 13, borderRadius: 12, border: "1px solid rgba(255,59,48,0.3)", background: "rgba(255,59,48,0.08)", color: "#ff3b30", fontFamily: "'Orbitron',monospace", fontSize: 12, cursor: "pointer", letterSpacing: "0.1em" }}>CLEAR ALL CODES</button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
