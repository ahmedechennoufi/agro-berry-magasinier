import { useState, useEffect, useRef } from "react";
import { collection, addDoc, query, where, onSnapshot, orderBy } from "firebase/firestore";
import { signOut } from "firebase/auth";
import { db, auth } from "../firebase";

const GITHUB_TOKEN = import.meta.env.VITE_GITHUB_TOKEN;
const GITHUB_OWNER = "ahmedechennoufi";
const GITHUB_REPO = "agro-berry-manager";
const GITHUB_FILE = "backups/agro-berry-data.json";

const FARM_CONFIG = {
  "AGRO BERRY 1": { cultures: ["Myrtille","Fraise"], destinations: { "Myrtille": ["Sol","Hydro","Foliaire","Pesticide"], "Fraise": ["Sol","Foliaire","Pesticide"] } },
  "AGRO BERRY 2": { cultures: ["Myrtille"], destinations: { "Myrtille": ["Sol","Hydro","Foliaire","Pesticide"] } },
  "AGRO BERRY 3": { cultures: ["Myrtille"], destinations: { "Myrtille": ["Hors Sol","Foliaire","Pesticide"] } },
};

const FARMS = ["AGRO BERRY 1","AGRO BERRY 2","AGRO BERRY 3"];

const ALL_MENUS = [
  { id:"stock",       label:"Mon Stock",      icon:"◈", color:"#4ade80", farms: null },
  { id:"consumption", label:"Consommation",   icon:"◉", color:"#f87171", farms: null },
  { id:"exit",        label:"Sortie magasin", icon:"◎", color:"#fbbf24", farms: ["AGRO BERRY 1"] },
  { id:"entry",       label:"Entrée",         icon:"◍", color:"#34d399", farms: null },
  { id:"transfer",    label:"Transfert",      icon:"⇌", color:"#a78bfa", farms: null },
  { id:"history",     label:"Mouvements",     icon:"◷", color:"#94a3b8", farms: null },
];

const TYPE_LABELS = {
  consumption: { label:"Consommation", color:"#f87171", icon:"◉" },
  exit: { label:"Sortie magasin", color:"#fbbf24", icon:"◎" },
  entry: { label:"Entrée", color:"#34d399", icon:"◍" },
  "transfer-out": { label:"Transfert sortant", color:"#a78bfa", icon:"⇌" },
  "transfer-in": { label:"Transfert entrant", color:"#60a5fa", icon:"⇌" },
};

async function fetchGitHubData() {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" }
  });
  if (!res.ok) throw new Error("Erreur GitHub " + res.status);
  const f = await res.json();
  return { data: JSON.parse(atob(f.content.replace(/\n/g,""))), sha: f.sha };
}

async function saveToGitHub(movements) {
  const mvArray = Array.isArray(movements) ? movements : [movements];
  const { data, sha } = await fetchGitHubData();
  mvArray.forEach((mv, i) => data.movements.push({ ...mv, id: Date.now() + i }));
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
  const put = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ message: `[${movement.farm}] ${movement.type}: ${movement.product} ${movement.quantity}${movement.unit}`, content, sha })
  });
  if (!put.ok) throw new Error("Erreur écriture GitHub " + put.status);
}

function calcFarmStock(movements, farmName, stockInitial) {
  const stock = {};
  for (const s of (stockInitial || [])) {
    stock[s.product] = { product: s.product, unit: s.unit || "KG", qty: s.quantity || 0 };
  }
  for (const mv of movements) {
    const p = mv.product;
    if (!stock[p]) stock[p] = { product: p, unit: mv.unit || "KG", qty: 0 };
    if (mv.type === "exit" && mv.farm === farmName) stock[p].qty += mv.quantity;
    if (mv.type === "transfer-in" && mv.farm === farmName) stock[p].qty += mv.quantity;
    if (mv.type === "consumption" && mv.farm === farmName) stock[p].qty -= mv.quantity;
    if (mv.type === "transfer-out" && mv.farm === farmName) stock[p].qty -= mv.quantity;
  }
  return Object.values(stock).filter(s => Math.abs(s.qty) > 0).sort((a,b) => a.product.localeCompare(b.product));
}

function getFarmMovements(movements, farmName) {
  return movements
    .filter(mv => mv.farm === farmName || mv.toFarm === farmName)
    .sort((a,b) => new Date(b.date) - new Date(a.date));
}

export default function Dashboard({ user, userInfo }) {
  const [active, setActive] = useState("stock");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");
  const [products, setProducts] = useState([]);
  const [farmStock, setFarmStock] = useState([]);
  const [farmMovements, setFarmMovements] = useState([]);
  const [loadingStock, setLoadingStock] = useState(true);
  const [search, setSearch] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [customProduct, setCustomProduct] = useState(false);
  const [stockSearch, setStockSearch] = useState("");
  const [mvSearch, setMvSearch] = useState("");
  const [mvFilter, setMvFilter] = useState("all");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const farmName = userInfo?.farm || "AGRO BERRY 1";
  const farmConfig = FARM_CONFIG[farmName] || FARM_CONFIG["AGRO BERRY 1"];
  const farmKey = farmName === "AGRO BERRY 1" ? "stockAB1" : farmName === "AGRO BERRY 2" ? "stockAB2" : "stockAB3";
  const MENUS = ALL_MENUS.filter(m => !m.farms || m.farms.includes(farmName));
  const emptyForm = { product:"", quantity:"", unit:"KG", culture:farmConfig.cultures[0], destination:"", supplier:"", price:"", toFarm:"", notes:"" };
  const [form, setForm] = useState(emptyForm);
  const fset = (k,v) => setForm(prev => ({ ...prev, [k]: v }));
  const destinations = farmConfig.destinations[form.culture] || [];

  const loadData = () => {
    setLoadingStock(true);
    fetchGitHubData().then(({ data }) => {
      setProducts([...data.products].sort((a,b) => a.name.localeCompare(b.name)));
      setFarmStock(calcFarmStock(data.movements, farmName, data[farmKey] || []));
      setFarmMovements(getFarmMovements(data.movements, farmName));
    }).catch(err => console.error('GitHub error:', err)).finally(() => setLoadingStock(false));
  };

  useEffect(() => { loadData(); }, [farmName]);

  // Recharger depuis GitHub quand on ouvre l'onglet Mouvements
  useEffect(() => {
    if (active === "history") loadData();
  }, [active]);

  const filtered = products.filter(p => p.name.toLowerCase().includes(search.toLowerCase())).slice(0,25);
  const filteredStock = farmStock.filter(s => s.product.toLowerCase().includes(stockSearch.toLowerCase()));
  const positiveStock = filteredStock.filter(s => s.qty > 0);
  const negativeStock = filteredStock.filter(s => s.qty < 0);

  const filteredMv = farmMovements.filter(mv => {
    const matchSearch = !mvSearch || mv.product?.toLowerCase().includes(mvSearch.toLowerCase());
    const matchFilter = mvFilter === "all" || mv.type === mvFilter ||
      (mvFilter === "entry" && mv.type === "exit" && farmName !== "AGRO BERRY 1");
    return matchSearch && matchFilter;
  });

  const handleSelectProduct = (p) => {
    fset("product", p.name); fset("unit", p.unit || "KG");
    setSearch(p.name); setShowDropdown(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true); setError("");
    try {
      const today = new Date().toISOString().split("T")[0];
      const mv = { type: active === "transfer" ? "transfer-out" : active, product: form.product, quantity: parseFloat(form.quantity), unit: form.unit, farm: farmName, date: today };
      if (active === "consumption") { mv.culture = form.culture; mv.destination = form.destination; }
      if (active === "entry") { if (form.supplier) mv.supplier = form.supplier; if (form.price) mv.price = parseFloat(form.price); }
      if (active === "transfer") mv.toFarm = form.toFarm;
      if (form.notes) mv.notes = form.notes;
      mv.saisiepar = user.email;

      const mouvementsToSave = [mv];

      // Si c'est une sortie magasin AGB1 vers AGB2 ou AGB3 → générer automatiquement une entrée sur la ferme destinataire
      if (active === "exit" && (form.toFarm === "AGRO BERRY 2" || form.toFarm === "AGRO BERRY 3")) {
        mv.toFarm = form.toFarm;
        const entryFarm = {
          type: "entry",
          product: mv.product,
          quantity: mv.quantity,
          unit: mv.unit,
          farm: form.toFarm,
          date: today,
          notes: `Entrée auto ← Magasin AGB1`,
          saisiepar: user.email,
          autoFrom: "AGRO BERRY 1",
        };
        mouvementsToSave.push(entryFarm);
      }

      await saveToGitHub(mouvementsToSave);
      for (const m of mouvementsToSave) {
        await addDoc(collection(db,"demandes"), { ...m, farmId: user.uid, farmName: m.farm, status: "saved", createdAt: new Date().toISOString() });
      }
      setFarmMovements(prev => [{ ...mv }, ...prev]);
      setFarmStock(prev => {
        const updated = [...prev];
        const idx = updated.findIndex(s => s.product === mv.product);
        const delta = (mv.type === "exit" || mv.type === "transfer-in") ? mv.quantity : -mv.quantity;
        if (idx >= 0) updated[idx] = { ...updated[idx], qty: updated[idx].qty + delta };
        else updated.push({ product: mv.product, unit: mv.unit, qty: delta });
        return updated.sort((a,b) => a.product.localeCompare(b.product));
      });
      setSuccess(true); setForm(emptyForm); setSearch(""); setCustomProduct(false);
      setTimeout(() => setSuccess(false), 4000);
    } catch(err) { setError(err.message); }
    setLoading(false);
  };

  const activeMenu = MENUS.find(m => m.id === active);
  const farmEmoji = farmName.includes("1") ? "🌿" : farmName.includes("2") ? "🍓" : "🫐";
  const farmShort = farmName.replace("AGRO BERRY ", "AB");
  const now = new Date();
  const dateStr = now.toLocaleDateString("fr-FR", { weekday:"short", day:"2-digit", month:"short", year:"numeric" });

  const css = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Space+Mono:wght@400;700&display=swap');
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Inter',sans-serif; background:#f5f5f7; color:#1d1d1f; }
    .app { display:flex; min-height:100vh; }

    /* ── SIDEBAR ── */
    .sidebar { width:240px; background:linear-gradient(180deg,#2ecc71 0%,#27ae60 100%); display:flex; flex-direction:column; position:fixed; top:0; left:0; height:100vh; z-index:100; transition:width 0.3s cubic-bezier(0.4,0,0.2,1); box-shadow:2px 0 12px rgba(39,174,96,0.15); }
    .sidebar.collapsed { width:68px; }
    .sidebar-header { padding:24px 16px 20px; border-bottom:1px solid rgba(255,255,255,0.15); display:flex; align-items:center; gap:12px; cursor:pointer; }
    .sidebar-logo { width:36px; height:36px; background:rgba(255,255,255,0.2); border-radius:10px; display:flex; align-items:center; justify-content:center; font-size:18px; flex-shrink:0; box-shadow:0 4px 12px rgba(0,0,0,0.1); }
    .sidebar-title { overflow:hidden; transition:opacity 0.2s; }
    .sidebar.collapsed .sidebar-title { opacity:0; width:0; }
    .sidebar-name { font-size:14px; font-weight:700; color:#fff; letter-spacing:-0.3px; }
    .sidebar-farm { font-size:11px; color:rgba(255,255,255,0.8); font-weight:500; margin-top:1px; }
    .sidebar-nav { flex:1; padding:12px 8px; overflow:hidden; }
    .nav-label { font-size:9px; font-weight:700; color:rgba(255,255,255,0.5); text-transform:uppercase; letter-spacing:0.1em; padding:12px 8px 6px; }
    .sidebar.collapsed .nav-label { opacity:0; }
    .nav-btn { width:100%; display:flex; align-items:center; gap:12px; padding:10px 12px; border-radius:10px; border:none; background:transparent; color:rgba(255,255,255,0.75); cursor:pointer; font-size:13px; font-weight:500; transition:all 0.2s; margin-bottom:2px; text-align:left; white-space:nowrap; overflow:hidden; font-family:'Inter',sans-serif; position:relative; }
    .nav-btn:hover { background:rgba(255,255,255,0.15); color:#fff; }
    .nav-btn.active { background:rgba(255,255,255,0.25); color:#fff; font-weight:600; }
    .nav-icon { font-size:17px; flex-shrink:0; width:20px; text-align:center; }
    .nav-text { transition:opacity 0.2s; }
    .sidebar.collapsed .nav-text { opacity:0; }
    .nav-badge { margin-left:auto; background:rgba(255,255,255,0.25); color:#fff; font-size:10px; padding:2px 7px; border-radius:20px; font-weight:700; transition:opacity 0.2s; flex-shrink:0; }
    .sidebar.collapsed .nav-badge { opacity:0; }
    .sidebar-footer { padding:12px 8px; border-top:1px solid rgba(255,255,255,0.15); }
    .user-info { display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:10px; background:rgba(255,255,255,0.12); margin-bottom:8px; overflow:hidden; }
    .user-avatar { width:30px; height:30px; background:rgba(255,255,255,0.25); border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; color:#fff; flex-shrink:0; }
    .user-email { font-size:11px; color:rgba(255,255,255,0.8); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; transition:opacity 0.2s; }
    .sidebar.collapsed .user-email { opacity:0; }
    .logout-btn { width:100%; padding:9px 12px; background:rgba(255,255,255,0.12); border:1px solid rgba(255,255,255,0.2); border-radius:10px; color:#fff; font-size:12px; cursor:pointer; font-weight:500; font-family:'Inter',sans-serif; transition:all 0.2s; display:flex; align-items:center; justify-content:center; gap:8px; }
    .logout-btn:hover { background:rgba(255,255,255,0.2); }
    .sidebar.collapsed .logout-text { display:none; }

    /* ── MAIN ── */
    .main { margin-left:240px; flex:1; min-height:100vh; transition:margin-left 0.3s cubic-bezier(0.4,0,0.2,1); }
    .main.collapsed { margin-left:68px; }
    .topbar { position:sticky; top:0; z-index:50; background:rgba(255,255,255,0.85); backdrop-filter:blur(20px); border-bottom:1px solid rgba(0,0,0,0.08); padding:16px 32px; display:flex; align-items:center; justify-content:space-between; }
    .topbar-left { display:flex; align-items:center; gap:12px; }
    .topbar-icon { font-size:20px; }
    .topbar-title { font-size:18px; font-weight:600; color:#1d1d1f; letter-spacing:-0.4px; }
    .topbar-sub { font-size:12px; color:#86868b; margin-top:1px; }
    .date-chip { background:linear-gradient(135deg,#f0fff4,#c6f6d5); border:1px solid rgba(52,199,89,0.3); padding:6px 12px; border-radius:20px; font-size:11px; color:#16a34a; font-weight:600; font-family:'Space Mono',monospace; }
    .page { padding:28px 32px; animation:fadeIn 0.3s ease; }
    @keyframes fadeIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }

    /* ── STOCK PAGE ── */
    .stock-header { display:flex; align-items:center; gap:16px; margin-bottom:24px; flex-wrap:wrap; }
    .stock-search { flex:1; min-width:200px; background:#fff; border:1px solid rgba(0,0,0,0.1); border-radius:12px; padding:10px 16px; font-size:13px; color:#1d1d1f; font-family:'Inter',sans-serif; outline:none; transition:all 0.2s; box-shadow:0 1px 4px rgba(0,0,0,0.04); }
    .stock-search:focus { border-color:rgba(52,199,89,0.5); box-shadow:0 0 0 3px rgba(52,199,89,0.1); }
    .stock-search::placeholder { color:#86868b; }
    .refresh-btn { padding:10px 16px; background:#34C759; border:none; border-radius:12px; color:#fff; font-size:13px; cursor:pointer; font-weight:600; font-family:'Inter',sans-serif; transition:all 0.2s; display:flex; align-items:center; gap:6px; box-shadow:0 2px 8px rgba(52,199,89,0.3); }
    .refresh-btn:hover { background:#2ebd52; transform:translateY(-1px); }
    .stock-stats { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:24px; }
    .stat-card { background:linear-gradient(135deg,#f0fff4,#dcfce7); border:1px solid rgba(52,199,89,0.2); border-radius:14px; padding:16px 20px; }
    .stat-label { font-size:11px; color:#6e6e73; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px; font-weight:600; }
    .stat-value { font-size:26px; font-weight:700; color:#1d1d1f; font-family:'Space Mono',monospace; letter-spacing:-1px; }
    .stat-value.green { color:#16a34a; }
    .stat-value.red { color:#dc2626; }
    .stock-table { background:#fff; border:1px solid rgba(0,0,0,0.08); border-radius:16px; overflow:hidden; box-shadow:0 1px 6px rgba(0,0,0,0.04); }
    .stock-table-header { display:grid; grid-template-columns:1fr 80px 120px; padding:12px 20px; background:#f5f5f7; border-bottom:1px solid rgba(0,0,0,0.08); font-size:10px; font-weight:700; color:#6e6e73; text-transform:uppercase; letter-spacing:0.08em; }
    .stock-row { display:grid; grid-template-columns:1fr 80px 120px; padding:13px 20px; border-bottom:1px solid rgba(0,0,0,0.05); transition:background 0.15s; align-items:center; }
    .stock-row:last-child { border-bottom:none; }
    .stock-row:hover { background:#f0fff4; }
    .stock-product { font-size:13px; font-weight:500; color:#1d1d1f; }
    .stock-unit { font-size:12px; color:#86868b; font-family:'Space Mono',monospace; }
    .stock-qty { font-size:14px; font-weight:700; text-align:right; font-family:'Space Mono',monospace; }
    .stock-qty.pos { color:#16a34a; }
    .stock-qty.neg { color:#dc2626; }
    .section-title { font-size:11px; font-weight:700; color:#6e6e73; text-transform:uppercase; letter-spacing:0.1em; padding:14px 20px 8px; border-bottom:1px solid rgba(0,0,0,0.05); }

    /* ── FORMS ── */
    .form-card { background:#fff; border:1px solid rgba(0,0,0,0.08); border-radius:20px; padding:28px; max-width:620px; box-shadow:0 2px 12px rgba(0,0,0,0.06); }
    .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    .form-group { display:flex; flex-direction:column; gap:6px; }
    .form-group.full { grid-column:1/-1; }
    .form-label { font-size:10px; font-weight:700; color:#6e6e73; text-transform:uppercase; letter-spacing:0.08em; }
    .form-input { background:#f5f5f7; border:1px solid rgba(0,0,0,0.1); border-radius:12px; padding:11px 14px; font-size:13px; color:#1d1d1f; font-family:'Inter',sans-serif; outline:none; transition:all 0.2s; width:100%; }
    .form-input:focus { border-color:rgba(52,199,89,0.5); background:#fff; box-shadow:0 0 0 3px rgba(52,199,89,0.1); }
    .form-input::placeholder { color:#86868b; }
    .form-input option { background:#fff; color:#1d1d1f; }
    .type-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .type-btn { padding:11px 14px; border-radius:12px; border:1px solid rgba(0,0,0,0.1); background:#f5f5f7; cursor:pointer; font-size:12px; font-weight:500; color:#6e6e73; text-align:left; font-family:'Inter',sans-serif; transition:all 0.2s; display:flex; align-items:center; gap:8px; }
    .type-btn:hover { border-color:rgba(52,199,89,0.3); color:#1d1d1f; background:#f0fff4; }
    .type-btn.active { border-color:currentColor; background:#f0fff4; color:#16a34a; }
    .product-wrap { position:relative; }
    .product-dropdown { position:absolute; top:calc(100% + 6px); left:0; right:0; background:#fff; border:1px solid rgba(0,0,0,0.1); border-radius:14px; max-height:240px; overflow-y:auto; z-index:200; box-shadow:0 12px 40px rgba(0,0,0,0.12); padding:4px; }
    .product-item { padding:10px 14px; border-radius:10px; cursor:pointer; display:flex; justify-content:space-between; align-items:center; transition:background 0.15s; font-size:13px; }
    .product-item:hover { background:#f0fff4; }
    .product-name { color:#1d1d1f; font-weight:500; }
    .product-meta { font-size:11px; color:#86868b; font-family:'Space Mono',monospace; }
    .product-add { padding:10px 14px; border-radius:10px; cursor:pointer; color:#16a34a; font-size:12px; font-weight:600; border-top:1px solid rgba(0,0,0,0.06); margin-top:4px; display:flex; align-items:center; gap:8px; transition:background 0.15s; }
    .product-add:hover { background:#f0fff4; }
    .back-link { font-size:11px; color:#86868b; background:none; border:none; cursor:pointer; padding:4px 0; text-decoration:underline; font-family:'Inter',sans-serif; }
    .submit-btn { width:100%; padding:14px; border:none; border-radius:13px; font-size:14px; font-weight:600; cursor:pointer; font-family:'Inter',sans-serif; transition:all 0.2s; display:flex; align-items:center; justify-content:center; gap:10px; letter-spacing:-0.2px; margin-top:8px; }
    .submit-btn:hover:not(:disabled) { transform:translateY(-1px); box-shadow:0 8px 24px rgba(52,199,89,0.3); }
    .submit-btn:disabled { opacity:0.5; cursor:not-allowed; transform:none; }
    .alert { padding:14px 16px; border-radius:12px; margin-bottom:20px; font-size:13px; font-weight:500; display:flex; align-items:center; gap:10px; }
    .alert.success { background:linear-gradient(135deg,#f0fff4,#dcfce7); border:1px solid rgba(52,199,89,0.3); color:#16a34a; }
    .alert.error { background:#fff5f5; border:1px solid rgba(220,38,38,0.2); color:#dc2626; }

    /* ── MOVEMENTS ── */
    .mv-header { display:flex; align-items:center; gap:12px; margin-bottom:20px; flex-wrap:wrap; }
    .mv-filters { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:20px; }
    .mv-filter-btn { padding:7px 14px; border-radius:20px; border:1px solid rgba(0,0,0,0.1); background:#fff; color:#6e6e73; font-size:12px; font-weight:500; cursor:pointer; font-family:'Inter',sans-serif; transition:all 0.2s; }
    .mv-filter-btn:hover { border-color:rgba(52,199,89,0.3); color:#16a34a; background:#f0fff4; }
    .mv-filter-btn.active { background:#34C759; border-color:#34C759; color:#fff; font-weight:600; }
    .mv-table { background:#fff; border:1px solid rgba(0,0,0,0.08); border-radius:16px; overflow:hidden; box-shadow:0 1px 6px rgba(0,0,0,0.04); }
    .mv-table-header { display:grid; grid-template-columns:100px 1fr 100px 80px 120px; padding:12px 20px; background:#f5f5f7; border-bottom:1px solid rgba(0,0,0,0.08); font-size:10px; font-weight:700; color:#6e6e73; text-transform:uppercase; letter-spacing:0.08em; }
    .mv-row { display:grid; grid-template-columns:100px 1fr 100px 80px 120px; padding:13px 20px; border-bottom:1px solid rgba(0,0,0,0.05); transition:background 0.15s; align-items:center; }
    .mv-row:last-child { border-bottom:none; }
    .mv-row:hover { background:#f5fff7; }
    .mv-date { font-size:12px; color:#86868b; font-family:'Space Mono',monospace; }
    .mv-product { font-size:13px; font-weight:500; color:#1d1d1f; }
    .mv-sub { font-size:11px; color:#86868b; margin-top:2px; }
    .mv-type { display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:600; padding:3px 10px; border-radius:20px; }
    .mv-qty { font-size:13px; font-weight:700; font-family:'Space Mono',monospace; text-align:right; }
    .mv-detail { font-size:11px; color:#86868b; text-align:right; }
    .empty-state { text-align:center; padding:60px 20px; }
    .empty-icon { font-size:48px; margin-bottom:12px; opacity:0.3; }
    .empty-text { color:#86868b; font-size:14px; }
    ::-webkit-scrollbar { width:4px; }
    ::-webkit-scrollbar-track { background:transparent; }
    ::-webkit-scrollbar-thumb { background:rgba(52,199,89,0.3); border-radius:4px; }
    .loading-spin { animation:spin 1s linear infinite; display:inline-block; }
    @keyframes spin { to { transform:rotate(360deg); } }
  `;

  return (
    <>
      <style>{css}</style>
      <div className="app">
        <div className={`sidebar ${sidebarOpen ? "" : "collapsed"}`}>
          <div className="sidebar-header" onClick={() => setSidebarOpen(!sidebarOpen)}>
            <div className="sidebar-logo">{farmEmoji}</div>
            <div className="sidebar-title">
              <div className="sidebar-name">Agro Berry</div>
              <div className="sidebar-farm">{farmShort}</div>
            </div>
          </div>
          <nav className="sidebar-nav">
            <div className="nav-label">Navigation</div>
            {MENUS.map(m => (
              <button key={m.id} className={`nav-btn ${active === m.id ? "active" : ""}`} onClick={() => setActive(m.id)}>
                <span className="nav-icon" style={{ color: active === m.id ? m.color : "" }}>{m.icon}</span>
                <span className="nav-text">{m.label}</span>
                {m.id === "stock" && farmStock.length > 0 && <span className="nav-badge">{farmStock.length}</span>}
                {m.id === "history" && farmMovements.length > 0 && <span className="nav-badge">{farmMovements.length}</span>}
              </button>
            ))}
          </nav>
          <div className="sidebar-footer">
            <div className="user-info">
              <div className="user-avatar">{user.email[0].toUpperCase()}</div>
              <div className="user-email">{user.email}</div>
            </div>
            <button className="logout-btn" onClick={() => signOut(auth)}>
              <span>↩</span><span className="logout-text">Déconnexion</span>
            </button>
          </div>
        </div>

        <div className={`main ${sidebarOpen ? "" : "collapsed"}`}>
          <div className="topbar">
            <div className="topbar-left">
              <span className="topbar-icon" style={{ color: activeMenu?.color }}>{activeMenu?.icon}</span>
              <div>
                <div className="topbar-title">{activeMenu?.label}</div>
                <div className="topbar-sub">{farmName}</div>
              </div>
            </div>
            <div className="date-chip">{dateStr}</div>
          </div>

          {/* STOCK */}
          {active === "stock" && (
            <div className="page">
              <div className="stock-stats">
                <div className="stat-card">
                  <div className="stat-label">En stock</div>
                  <div className="stat-value green">{loadingStock ? "—" : positiveStock.length}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Négatifs</div>
                  <div className="stat-value red">{loadingStock ? "—" : negativeStock.length}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Total</div>
                  <div className="stat-value">{loadingStock ? "—" : filteredStock.length}</div>
                </div>
              </div>
              <div className="stock-header">
                <input className="stock-search" placeholder="Rechercher un produit..." value={stockSearch} onChange={e => setStockSearch(e.target.value)} />
                <button className="refresh-btn" onClick={loadData}>
                  <span className={loadingStock ? "loading-spin" : ""}>↻</span> Actualiser
                </button>
              </div>
              {loadingStock ? (
                <div className="empty-state"><div className="empty-icon loading-spin">◈</div><div className="empty-text">Chargement...</div></div>
              ) : (
                <div className="stock-table">
                  <div className="stock-table-header"><span>Produit</span><span>Unité</span><span style={{textAlign:"right"}}>Quantité</span></div>
                  {positiveStock.length > 0 && <div className="section-title">✓ En stock ({positiveStock.length})</div>}
                  {positiveStock.map(s => (
                    <div key={s.product} className="stock-row">
                      <span className="stock-product">{s.product}</span>
                      <span className="stock-unit">{s.unit}</span>
                      <span className="stock-qty pos">{s.qty % 1 === 0 ? s.qty : s.qty.toFixed(2)}</span>
                    </div>
                  ))}
                  {negativeStock.length > 0 && <div className="section-title">⚠ Négatifs ({negativeStock.length})</div>}
                  {negativeStock.map(s => (
                    <div key={s.product} className="stock-row">
                      <span className="stock-product">{s.product}</span>
                      <span className="stock-unit">{s.unit}</span>
                      <span className="stock-qty neg">{s.qty.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* FORMS */}
          {active !== "history" && active !== "stock" && (
            <div className="page">
              <div className="form-card">
                {success && <div className="alert success">✓ Enregistré avec succès !{active === "exit" && form.toFarm ? ` · Entrée créée automatiquement sur ${form.toFarm.replace("AGRO BERRY ","AGB")}.` : ""}</div>}
                {error && <div className="alert error">✗ {error}</div>}
                <form onSubmit={handleSubmit}>
                  <div className="form-grid">
                    <div className="form-group full">
                      <div className="form-label">Type de mouvement</div>
                      <div className="type-grid">
                        {MENUS.filter(m => m.id !== "stock" && m.id !== "history").map(m => (
                          <button key={m.id} type="button" className={`type-btn ${active === m.id ? "active" : ""}`}
                            style={{ color: active === m.id ? m.color : "" }} onClick={() => setActive(m.id)}>
                            <span>{m.icon}</span>{m.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="form-group full">
                      <div className="form-label">Produit *</div>
                      {!customProduct ? (
                        <div className="product-wrap">
                          <input className="form-input" value={search} placeholder="Rechercher un produit..."
                            onChange={e => { setSearch(e.target.value); fset("product", e.target.value); setShowDropdown(true); }}
                            onFocus={() => setShowDropdown(true)} onBlur={() => setTimeout(() => setShowDropdown(false), 150)} autoComplete="off" />
                          {showDropdown && search && (
                            <div className="product-dropdown">
                              {filtered.map(p => (
                                <div key={p.id} className="product-item" onMouseDown={() => handleSelectProduct(p)}>
                                  <span className="product-name">{p.name}</span>
                                  <span className="product-meta">{p.unit} · {p.category}</span>
                                </div>
                              ))}
                              <div className="product-add" onMouseDown={() => { setCustomProduct(true); fset("product",""); setSearch(""); setShowDropdown(false); }}>
                                + Nouveau produit
                              </div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div>
                          <input className="form-input" value={form.product} onChange={e => fset("product", e.target.value)} placeholder="Nom du nouveau produit" required autoFocus />
                          <button type="button" className="back-link" onClick={() => { setCustomProduct(false); fset("product",""); setSearch(""); }}>← Choisir depuis la liste</button>
                        </div>
                      )}
                    </div>
                    <div className="form-group">
                      <div className="form-label">Quantité *</div>
                      <input type="number" className="form-input" value={form.quantity} onChange={e => fset("quantity", e.target.value)} placeholder="0" required min="0" step="0.01" />
                    </div>
                    <div className="form-group">
                      <div className="form-label">Unité</div>
                      <select className="form-input" value={form.unit} onChange={e => fset("unit", e.target.value)}>
                        <option value="KG">KG</option><option value="L">L</option><option value="UNITÉ">UNITÉ</option>
                      </select>
                    </div>
                    {active === "consumption" && <>
                      <div className="form-group">
                        <div className="form-label">Culture</div>
                        <select className="form-input" value={form.culture} onChange={e => fset("culture", e.target.value)}>
                          {farmConfig.cultures.map(c => <option key={c}>{c}</option>)}
                        </select>
                      </div>
                      <div className="form-group">
                        <div className="form-label">Destination</div>
                        <select className="form-input" value={form.destination} onChange={e => fset("destination", e.target.value)}>
                          <option value="">Sélectionner</option>
                          {destinations.map(d => <option key={d}>{d}</option>)}
                        </select>
                      </div>
                    </>}
                    {active === "entry" && <>
                      <div className="form-group">
                        <div className="form-label">Fournisseur</div>
                        <input className="form-input" value={form.supplier} onChange={e => fset("supplier", e.target.value)} placeholder="Nom du fournisseur" />
                      </div>
                      <div className="form-group">
                        <div className="form-label">Prix (MAD)</div>
                        <input type="number" className="form-input" value={form.price} onChange={e => fset("price", e.target.value)} placeholder="0.00" min="0" step="0.01" />
                      </div>
                    </>}
                    {active === "transfer" && (
                      <div className="form-group full">
                        <div className="form-label">Vers la ferme *</div>
                        <select className="form-input" value={form.toFarm} onChange={e => fset("toFarm", e.target.value)} required>
                          <option value="">Sélectionner</option>
                          {FARMS.filter(f => f !== farmName).map(f => <option key={f}>{f}</option>)}
                        </select>
                      </div>
                    )}
                    {active === "exit" && (
                      <div className="form-group full">
                        <div className="form-label">Ferme destinataire</div>
                        <select className="form-input" value={form.toFarm} onChange={e => fset("toFarm", e.target.value)}>
                          <option value="">Sortie externe (pas de ferme)</option>
                          <option value="AGRO BERRY 2">AGRO BERRY 2</option>
                          <option value="AGRO BERRY 3">AGRO BERRY 3</option>
                        </select>
                        {form.toFarm && <div style={{fontSize:11,color:"#16a34a",marginTop:6,fontWeight:500}}>✓ Une entrée sera créée automatiquement sur {form.toFarm.replace("AGRO BERRY ","AGB")}</div>}
                      </div>
                    )}
                    <div className="form-group full">
                      <div className="form-label">Notes (optionnel)</div>
                      <textarea className="form-input" value={form.notes} onChange={e => fset("notes", e.target.value)} placeholder="Informations supplémentaires..." rows={2} style={{ resize:"vertical" }} />
                    </div>
                  </div>
                  <button type="submit" disabled={loading} className="submit-btn"
                    style={{ background: `linear-gradient(135deg, ${activeMenu?.color}22, ${activeMenu?.color}44)`, color: activeMenu?.color, border: `1px solid ${activeMenu?.color}44` }}>
                    {loading ? <><span className="loading-spin">◈</span> Enregistrement...</> : <><span>{activeMenu?.icon}</span> Enregistrer dans le stock</>}
                  </button>
                </form>
              </div>
            </div>
          )}

          {/* MOUVEMENTS - équivalent app admin */}
          {active === "history" && (
            <div className="page">
              <div className="mv-header">
                <input className="stock-search" style={{maxWidth:320}} placeholder="Rechercher un produit..." value={mvSearch} onChange={e => setMvSearch(e.target.value)} />
                <button className="refresh-btn" onClick={loadData}>
                  <span className={loadingStock ? "loading-spin" : ""}>↻</span> Actualiser
                </button>
                <span style={{fontSize:12,color:"#4b5563",marginLeft:"auto"}}>{filteredMv.length} mouvement{filteredMv.length > 1 ? "s" : ""}</span>
              </div>
              <div className="mv-filters">
                {[
                  { id:"all", label:"Tous" },
                  { id:"consumption", label:"Consommations" },
                  { id:"exit", label:"Sorties" },
                  { id:"entry", label:"Entrées" },
                  { id:"transfer-out", label:"Transferts" },
                ].map(f => (
                  <button key={f.id} className={`mv-filter-btn ${mvFilter === f.id ? "active" : ""}`} onClick={() => setMvFilter(f.id)}>{f.label}</button>
                ))}
              </div>
              {loadingStock ? (
                <div className="empty-state"><div className="empty-icon loading-spin">◈</div><div className="empty-text">Chargement...</div></div>
              ) : filteredMv.length === 0 ? (
                <div className="empty-state"><div className="empty-icon">◷</div><div className="empty-text">Aucun mouvement trouvé</div></div>
              ) : (
                <div className="mv-table">
                  <div className="mv-table-header">
                    <span>Date</span><span>Produit</span><span>Type</span><span style={{textAlign:"right"}}>Quantité</span><span style={{textAlign:"right"}}>Détail</span>
                  </div>
                  {filteredMv.map((mv, i) => {
                    // Pour AGB2/AGB3 : les sorties magasin (exit) viennent du magasin centrale → afficher comme Entrée
                    const isEntryFromMagasin = mv.type === "exit" && farmName !== "AGRO BERRY 1";
                    const resolvedType = isEntryFromMagasin ? "entry" : mv.type;
                    const t = isEntryFromMagasin
                      ? { label: "Entrée magasin", color: "#34d399", icon: "◍" }
                      : (TYPE_LABELS[mv.type] || { label: mv.type, color: "#94a3b8", icon: "◷" });
                    const isPlus = resolvedType === "entry" || resolvedType === "transfer-in";
                    return (
                      <div key={mv.id || i} className="mv-row">
                        <span className="mv-date">{mv.date}</span>
                        <div>
                          <div className="mv-product">{mv.product}</div>
                          {(mv.culture || mv.destination) && <div className="mv-sub">{mv.culture}{mv.destination ? ` · ${mv.destination}` : ""}</div>}
                          {mv.supplier && <div className="mv-sub">{mv.supplier}</div>}
                          {mv.toFarm && <div className="mv-sub">→ {mv.toFarm}</div>}
                        </div>
                        <div>
                          <span className="mv-type" style={{ background: `${t.color}18`, color: t.color }}>
                            {t.icon} {t.label}
                          </span>
                        </div>
                        <div className="mv-qty" style={{ color: isPlus ? "#4ade80" : "#f87171" }}>
                          {isPlus ? "+" : "-"}{mv.quantity}
                        </div>
                        <div className="mv-detail">{mv.unit}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
