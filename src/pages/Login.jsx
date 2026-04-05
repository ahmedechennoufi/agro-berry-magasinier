import { useState } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "../firebase";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      setError("Email ou mot de passe incorrect");
    }
    setLoading(false);
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(135deg, #f0fff4 0%, #dcfce7 50%, #bbf7d0 100%)", fontFamily: "'Inter', sans-serif" }}>
      <div style={{ background: "white", borderRadius: 20, padding: "40px 32px", width: "100%", maxWidth: 380, boxShadow: "0 8px 40px rgba(39,174,96,0.15), 0 2px 12px rgba(0,0,0,0.06)" }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ width: 64, height: 64, background: "linear-gradient(135deg, #2ecc71, #27ae60)", borderRadius: 18, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32, margin: "0 auto 16px", boxShadow: "0 6px 20px rgba(39,174,96,0.35)" }}>🫐</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: "#1d1d1f", letterSpacing: "-0.5px" }}>Agro Berry</h1>
          <p style={{ fontSize: 13, color: "#86868b", margin: "4px 0 0", fontWeight: 500 }}>Espace Magasinier</p>
        </div>

        <form onSubmit={handleLogin}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#6e6e73", display: "block", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="agb1@agroberry.ma"
              required
              style={{ width: "100%", padding: "11px 14px", border: "1px solid rgba(0,0,0,0.1)", borderRadius: 12, fontSize: 13, boxSizing: "border-box", outline: "none", background: "#f5f5f7", color: "#1d1d1f", fontFamily: "inherit", transition: "all 0.2s" }}
              onFocus={e => { e.target.style.borderColor = "rgba(52,199,89,0.5)"; e.target.style.boxShadow = "0 0 0 3px rgba(52,199,89,0.1)"; e.target.style.background = "#fff"; }}
              onBlur={e => { e.target.style.borderColor = "rgba(0,0,0,0.1)"; e.target.style.boxShadow = "none"; e.target.style.background = "#f5f5f7"; }}
            />
          </div>
          <div style={{ marginBottom: 24 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#6e6e73", display: "block", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Mot de passe</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              style={{ width: "100%", padding: "11px 14px", border: "1px solid rgba(0,0,0,0.1)", borderRadius: 12, fontSize: 13, boxSizing: "border-box", outline: "none", background: "#f5f5f7", color: "#1d1d1f", fontFamily: "inherit", transition: "all 0.2s" }}
              onFocus={e => { e.target.style.borderColor = "rgba(52,199,89,0.5)"; e.target.style.boxShadow = "0 0 0 3px rgba(52,199,89,0.1)"; e.target.style.background = "#fff"; }}
              onBlur={e => { e.target.style.borderColor = "rgba(0,0,0,0.1)"; e.target.style.boxShadow = "none"; e.target.style.background = "#f5f5f7"; }}
            />
          </div>
          {error && <p style={{ color: "#dc2626", fontSize: 13, marginBottom: 16, textAlign: "center", background: "#fff5f5", border: "1px solid rgba(220,38,38,0.2)", borderRadius: 10, padding: "10px" }}>{error}</p>}
          <button
            type="submit"
            disabled={loading}
            style={{ width: "100%", padding: "13px", background: "linear-gradient(135deg, #2ecc71, #27ae60)", color: "white", border: "none", borderRadius: 12, fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", boxShadow: "0 4px 16px rgba(39,174,96,0.35)", transition: "all 0.2s", letterSpacing: "-0.2px" }}
          >
            {loading ? "Connexion..." : "Se connecter"}
          </button>
        </form>
      </div>
    </div>
  );
}
