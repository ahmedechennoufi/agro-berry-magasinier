import { useState, useEffect } from "react";
import { collection, addDoc, query, where, onSnapshot, orderBy } from "firebase/firestore";
import { signOut } from "firebase/auth";
import { db, auth } from "../firebase";

const TYPES = [
  { value: "consumption", label: "Consommation", color: "#e24b4a", icon: "🔥" },
  { value: "exit", label: "Sortie magasin", color: "#BA7517", icon: "📤" },
  { value: "entry", label: "Entrée", color: "#1d9e75", icon: "📥" },
  { value: "transfer", label: "Transfert", color: "#534AB7", icon: "🔄" },
];

const STATUS_COLORS = {
  pending: { bg: "#FAEEDA", text: "#633806", label: "En attente" },
  validated: { bg: "#EAF3DE", text: "#27500A", label: "Validé" },
  rejected: { bg: "#FCEBEB", text: "#791F1F", label: "Rejeté" },
};

export default function Dashboard({ user, userInfo }) {
  const [tab, setTab] = useState("new");
  const [demandes, setDemandes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const [form, setForm] = useState({
    type: "consumption",
    product: "",
    quantity: "",
    unit: "",
    culture: "",
    destination: "",
    notes: "",
    toFarm: "",
  });

  const farmName = userInfo?.farm || "Ferme";

  useEffect(() => {
    const q = query(
      collection(db, "demandes"),
      where("farmId", "==", user.uid),
      orderBy("createdAt", "desc")
    );
    const unsub = onSnapshot(q, snap => {
      setDemandes(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, [user.uid]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await addDoc(collection(db, "demandes"), {
        ...form,
        quantity: parseFloat(form.quantity),
        farmId: user.uid,
        farmName,
        status: "pending",
        createdAt: new Date().toISOString(),
        createdBy: user.email,
      });
      setSuccess(true);
      setForm({ type: "consumption", product: "", quantity: "", unit: "", culture: "", destination: "", notes: "", toFarm: "" });
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      alert("Erreur: " + err.message);
    }
    setLoading(false);
  };

  const pending = demandes.filter(d => d.status === "pending").length;

  return (
    <div style={{ minHeight: "100vh", background: "#f5f5f0", fontFamily: "system-ui, sans-serif" }}>
      {/* Header */}
      <div style={{ background: "white", borderBottom: "1px solid #eee", padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 24 }}>🫐</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{farmName}</div>
            <div style={{ fontSize: 12, color: "#888" }}>{user.email}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {pending > 0 && (
            <span style={{ background: "#FAEEDA", color: "#633806", fontSize: 12, padding: "3px 10px", borderRadius: 20, fontWeight: 500 }}>
              {pending} en attente
            </span>
          )}
          <button onClick={() => signOut(auth)} style={{ background: "none", border: "1px solid #ddd", borderRadius: 8, padding: "6px 12px", fontSize: 13, cursor: "pointer", color: "#666" }}>
            Déconnexion
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ background: "white", borderBottom: "1px solid #eee", padding: "0 20px", display: "flex", gap: 0 }}>
        {[{ id: "new", label: "Nouvelle saisie" }, { id: "history", label: `Historique (${demandes.length})` }].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ padding: "14px 20px", border: "none", background: "none", fontSize: 14, fontWeight: tab === t.id ? 600 : 400, color: tab === t.id ? "#1d9e75" : "#666", borderBottom: tab === t.id ? "2px solid #1d9e75" : "2px solid transparent", cursor: "pointer" }}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ padding: "20px 16px", maxWidth: 600, margin: "0 auto" }}>

        {/* NEW FORM */}
        {tab === "new" && (
          <div style={{ background: "white", borderRadius: 12, padding: 20, boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
            <h2 style={{ margin: "0 0 20px", fontSize: 16, fontWeight: 600 }}>Nouvelle saisie — {farmName}</h2>

            {success && (
              <div style={{ background: "#EAF3DE", color: "#27500A", padding: "12px 16px", borderRadius: 8, marginBottom: 16, fontSize: 14, fontWeight: 500 }}>
                ✅ Demande envoyée — en attente de validation
              </div>
            )}

            <form onSubmit={handleSubmit}>
              {/* Type */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 13, fontWeight: 500, color: "#555", display: "block", marginBottom: 8 }}>Type de mouvement</label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {TYPES.map(t => (
                    <button key={t.value} type="button" onClick={() => setForm(f => ({ ...f, type: t.value }))}
                      style={{ padding: "10px 12px", border: `2px solid ${form.type === t.value ? t.color : "#eee"}`, borderRadius: 8, background: form.type === t.value ? t.color + "15" : "white", cursor: "pointer", fontSize: 13, fontWeight: form.type === t.value ? 600 : 400, color: form.type === t.value ? t.color : "#555", textAlign: "left" }}>
                      {t.icon} {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Product */}
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 13, fontWeight: 500, color: "#555", display: "block", marginBottom: 6 }}>Produit *</label>
                <input value={form.product} onChange={e => setForm(f => ({ ...f, product: e.target.value }))} placeholder="Ex: MAP, ENTEC, SULFATE..." required
                  style={{ width: "100%", padding: "10px 12px", border: "1px solid #ddd", borderRadius: 8, fontSize: 14, boxSizing: "border-box" }} />
              </div>

              {/* Quantity + Unit */}
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10, marginBottom: 14 }}>
                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, color: "#555", display: "block", marginBottom: 6 }}>Quantité *</label>
                  <input type="number" value={form.quantity} onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))} placeholder="0" required min="0" step="0.01"
                    style={{ width: "100%", padding: "10px 12px", border: "1px solid #ddd", borderRadius: 8, fontSize: 14, boxSizing: "border-box" }} />
                </div>
                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, color: "#555", display: "block", marginBottom: 6 }}>Unité</label>
                  <select value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))}
                    style={{ width: "100%", padding: "10px 12px", border: "1px solid #ddd", borderRadius: 8, fontSize: 14, boxSizing: "border-box" }}>
                    <option value="KG">KG</option>
                    <option value="L">L</option>
                    <option value="UNITÉ">UNITÉ</option>
                  </select>
                </div>
              </div>

              {/* Culture + Destination (consumption only) */}
              {form.type === "consumption" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
                  <div>
                    <label style={{ fontSize: 13, fontWeight: 500, color: "#555", display: "block", marginBottom: 6 }}>Culture</label>
                    <select value={form.culture} onChange={e => setForm(f => ({ ...f, culture: e.target.value }))}
                      style={{ width: "100%", padding: "10px 12px", border: "1px solid #ddd", borderRadius: 8, fontSize: 14, boxSizing: "border-box" }}>
                      <option value="">Sélectionner</option>
                      <option value="Myrtille">Myrtille</option>
                      <option value="Fraise">Fraise</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 13, fontWeight: 500, color: "#555", display: "block", marginBottom: 6 }}>Destination</label>
                    <select value={form.destination} onChange={e => setForm(f => ({ ...f, destination: e.target.value }))}
                      style={{ width: "100%", padding: "10px 12px", border: "1px solid #ddd", borderRadius: 8, fontSize: 14, boxSizing: "border-box" }}>
                      <option value="">Sélectionner</option>
                      <option value="Sol">Sol</option>
                      <option value="Hydro">Hydro</option>
                      <option value="Foliaire">Foliaire</option>
                      <option value="Pesticide">Pesticide</option>
                    </select>
                  </div>
                </div>
              )}

              {/* Transfer to farm */}
              {form.type === "transfer" && (
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 13, fontWeight: 500, color: "#555", display: "block", marginBottom: 6 }}>Vers la ferme</label>
                  <select value={form.toFarm} onChange={e => setForm(f => ({ ...f, toFarm: e.target.value }))}
                    style={{ width: "100%", padding: "10px 12px", border: "1px solid #ddd", borderRadius: 8, fontSize: 14, boxSizing: "border-box" }}>
                    <option value="">Sélectionner</option>
                    <option value="AGRO BERRY 1">AGRO BERRY 1</option>
                    <option value="AGRO BERRY 2">AGRO BERRY 2</option>
                    <option value="AGRO BERRY 3">AGRO BERRY 3</option>
                  </select>
                </div>
              )}

              {/* Notes */}
              <div style={{ marginBottom: 20 }}>
                <label style={{ fontSize: 13, fontWeight: 500, color: "#555", display: "block", marginBottom: 6 }}>Notes (optionnel)</label>
                <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Informations supplémentaires..." rows={2}
                  style={{ width: "100%", padding: "10px 12px", border: "1px solid #ddd", borderRadius: 8, fontSize: 14, boxSizing: "border-box", resize: "vertical" }} />
              </div>

              <button type="submit" disabled={loading}
                style={{ width: "100%", padding: "13px", background: "#1d9e75", color: "white", border: "none", borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>
                {loading ? "Envoi en cours..." : "📤 Envoyer pour validation"}
              </button>
            </form>
          </div>
        )}

        {/* HISTORY */}
        {tab === "history" && (
          <div>
            {demandes.length === 0 ? (
              <div style={{ background: "white", borderRadius: 12, padding: 40, textAlign: "center", color: "#999" }}>
                <div style={{ fontSize: 40, marginBottom: 8 }}>📋</div>
                <p>Aucune saisie pour le moment</p>
              </div>
            ) : (
              demandes.map(d => {
                const s = STATUS_COLORS[d.status] || STATUS_COLORS.pending;
                const t = TYPES.find(t => t.value === d.type) || TYPES[0];
                return (
                  <div key={d.id} style={{ background: "white", borderRadius: 12, padding: 16, marginBottom: 10, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                      <div>
                        <span style={{ fontSize: 13, fontWeight: 600, color: t.color }}>{t.icon} {t.label}</span>
                        <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>{d.product}</div>
                      </div>
                      <span style={{ background: s.bg, color: s.text, fontSize: 12, padding: "3px 10px", borderRadius: 20, fontWeight: 500, whiteSpace: "nowrap" }}>
                        {s.label}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 16, fontSize: 13, color: "#666" }}>
                      <span>📦 {d.quantity} {d.unit}</span>
                      {d.culture && <span>🌿 {d.culture}</span>}
                      {d.destination && <span>📍 {d.destination}</span>}
                      {d.toFarm && <span>→ {d.toFarm}</span>}
                    </div>
                    {d.notes && <p style={{ margin: "8px 0 0", fontSize: 13, color: "#888" }}>💬 {d.notes}</p>}
                    {d.adminNote && (
                      <div style={{ marginTop: 8, padding: "8px 10px", background: d.status === "rejected" ? "#FCEBEB" : "#EAF3DE", borderRadius: 6, fontSize: 13, color: d.status === "rejected" ? "#791F1F" : "#27500A" }}>
                        Admin: {d.adminNote}
                      </div>
                    )}
                    <div style={{ marginTop: 8, fontSize: 11, color: "#bbb" }}>
                      {new Date(d.createdAt).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
