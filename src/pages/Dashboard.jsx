import { useState, useEffect, useRef } from "react";
import { signOut } from "firebase/auth";
import { auth, db } from "../firebase";
import { doc, setDoc, deleteDoc, writeBatch, onSnapshot, collection, getDoc, getDocs } from "firebase/firestore";
import * as XLSX from "xlsx";
import * as XLSXStyle from "xlsx-js-style";

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

// Thèmes Berry — couleur de marque par ferme. Les indicateurs fonctionnels
// (vert positif / rouge négatif / orange warning / violet transfert) restent
// inchangés ailleurs dans l'app.
const FARM_THEMES = {
  "AGRO BERRY 1": { // Bleu myrtille
    primary:    "#1e3a8a",
    bright:     "#3b82f6",
    dark:       "#1e40af",
    darkest:    "#1e3a8a",
    bgLight:    "#eff6ff",
    bgMedium:   "#dbeafe",
    rgb:        "30, 58, 138",
    rgbLight:   "59, 130, 246",
  },
  "AGRO BERRY 2": { // Magenta vif
    primary:    "#a21caf",
    bright:     "#d946ef",
    dark:       "#c026d3",
    darkest:    "#86198f",
    bgLight:    "#fdf4ff",
    bgMedium:   "#f5d0fe",
    rgb:        "192, 38, 211",
    rgbLight:   "217, 70, 239",
  },
  "AGRO BERRY 3": { // Vert sauge / teal
    primary:    "#0d9488",
    bright:     "#14b8a6",
    dark:       "#0f766e",
    darkest:    "#115e59",
    bgLight:    "#f0fdfa",
    bgMedium:   "#ccfbf1",
    rgb:        "13, 148, 136",
    rgbLight:   "20, 184, 166",
  },
};

const ALL_MENUS = [
  { id:"stock",       label:"Mon Stock",    icon:"◈", color:"#4ade80", farms: null },
  { id:"consumption", label:"Consommation", icon:"◉", color:"#f87171", farms: null },
  { id:"transfer",    label:"Transfert",    icon:"⇌", color:"#a78bfa", farms: null },
  { id:"history",     label:"Mouvements",   icon:"◷", color:"#94a3b8", farms: null },
  { id:"alerts",      label:"Alertes",      icon:"⚠", color:"#f59e0b", farms: null },
  { id:"melanges",    label:"Mélanges",     icon:"⚗", color:"#06b6d4", farms: null },
  { id:"report",      label:"Rapport Mensuel", icon:"📊", color:"#8b5cf6", farms: null },
  { id:"globalstock", label:"Stock Global",  icon:"🌍", color:"#0ea5e9", farms: null },
];

// Stock du magasin central = achats fournisseurs (entry) - livraisons vers fermes (exit),
// tous mouvements confondus (meme logique que calculateWarehouseStock cote Manager).
function calcCentralStock(movements) {
  const stock = {};
  (movements || []).forEach(m => {
    const p = m.product;
    if (!p) return;
    if (!stock[p]) stock[p] = { product: p, unit: m.unit || "KG", qty: 0 };
    if (m.type === "entry") stock[p].qty += parseFloat(m.quantity) || 0;
    else if (m.type === "exit") stock[p].qty -= parseFloat(m.quantity) || 0;
  });
  return stock;
}

// Périodes mensuelles — mêmes bornes que le Manager (Consommation Fermes),
// pour que les deux apps affichent des chiffres cohérents pour un même mois.
const MONTH_PERIODS = {
  'SEPTEMBRE': { start: '2025-08-26', end: '2025-09-25', label: 'Septembre 2025' },
  'OCTOBRE':   { start: '2025-09-26', end: '2025-10-25', label: 'Octobre 2025' },
  'NOVEMBRE':  { start: '2025-10-26', end: '2025-11-25', label: 'Novembre 2025' },
  'DECEMBRE':  { start: '2025-11-26', end: '2025-12-25', label: 'Décembre 2025' },
  'JANVIER':   { start: '2025-12-26', end: '2026-01-25', label: 'Janvier 2026' },
  'FEVRIER':   { start: '2026-01-26', end: '2026-02-25', label: 'Février 2026' },
  'MARS':      { start: '2026-02-26', end: '2026-03-25', label: 'Mars 2026' },
  'AVRIL':     { start: '2026-03-26', end: '2026-04-25', label: 'Avril 2026' },
  'MAI':       { start: '2026-04-26', end: '2026-05-25', label: 'Mai 2026' },
  'JUIN':      { start: '2026-05-26', end: '2026-06-25', label: 'Juin 2026' },
  'JUILLET':   { start: '2026-06-26', end: '2026-07-25', label: 'Juillet 2026' },
  'AOUT':      { start: '2026-08-01', end: '2026-08-31', label: 'Août 2026' },
};

// Rapport de consommation pour UNE ferme sur une période donnée.
// Réutilise calcFarmStock (déjà éprouvé) pour établir le stock initial
// = stock de la ferme calculé juste avant `start`, puis additionne les
// mouvements de la période pour obtenir Entrées / Sorties / Consommation / Stock Final.
function getFarmConsumptionReport(movements, farmName, physicalInventories, start, end) {
  const movementsBeforeStart = (movements || []).filter(m => m.date && m.date < start);
  const initStockArr = calcFarmStock(movementsBeforeStart, farmName, [], physicalInventories);

  const rows = {};
  const ensure = (product, unit) => {
    if (!rows[product]) rows[product] = { product, unit: unit || "KG", init: 0, ent: 0, sort: 0, cons: 0 };
    return rows[product];
  };
  initStockArr.forEach(s => { ensure(s.product, s.unit).init = s.qty; });

  (movements || []).forEach(m => {
    if (!m.date || m.date < start || m.date > end) return;
    if (m.farm !== farmName) return;
    const p = m.product;
    if (!p) return;
    const r = ensure(p, m.unit);
    const qty = parseFloat(m.quantity) || 0;
    if (m.type === "exit" || m.type === "transfer-in") r.ent += qty;
    else if (m.type === "transfer-out") r.sort += qty;
    else if (m.type === "consumption") r.cons += qty;
  });

  return Object.values(rows)
    .map(r => ({ ...r, final: Math.max(0, r.init + r.ent - r.sort - r.cons) }))
    .filter(r => r.init > 0.001 || r.ent > 0.001 || r.sort > 0.001 || r.cons > 0.001 || r.final > 0.001)
    .sort((a,b) => a.product.localeCompare(b.product));
}

// Charger/calculer les mélanges depuis les données GitHub ou localStorage
const loadMelanges = (githubData, farmName) => {
  try {
    const fromGithub = githubData?.melangesConfig?.[farmName];
    if (fromGithub && (fromGithub.horsSol?.length > 0 || fromGithub.sol?.length > 0)) {
      localStorage.setItem("melanges_" + farmName, JSON.stringify(fromGithub));
      localStorage.setItem("melanges_cache", JSON.stringify(fromGithub));
      return fromGithub;
    }
    const cached = localStorage.getItem("melanges_" + farmName) || localStorage.getItem("melanges_cache");
    if (cached) return JSON.parse(cached);
    return { horsSol: [], sol: [] };
  } catch { return { horsSol: [], sol: [] }; }
};

// Calculer les seuils depuis les mélanges configurés (×5)
const calcSeuils = (melangesConfig) => {
  const seuils = {};
  const NB = 5;
  [...(melangesConfig.horsSol||[]), ...(melangesConfig.sol||[])].forEach(({ product, qty, unit }) => {
    if (!product) return;
    const key = product.toUpperCase();
    if (!seuils[key]) seuils[key] = { qty: 0, unit: unit || "KG" };
    seuils[key].qty += (parseFloat(qty) || 0) * NB;
  });
  return seuils;
};
const TYPE_LABELS = {
  consumption: { label:"Consommation", color:"#f87171", icon:"◉" },
  exit: { label:"Sortie magasin", color:"#fbbf24", icon:"◎" },
  entry: { label:"Entrée", color:"#34d399", icon:"◍" },
  "transfer-out": { label:"Transfert sortant", color:"#a78bfa", icon:"⇌" },
  "transfer-in": { label:"Transfert entrant", color:"#60a5fa", icon:"⇌" },
};

// Nettoyer les unités corrompues
const cleanUnit = (u) => {
  if (!u) return "KG";
  if (u.startsWith("UNIT")) return "UNITE";
  return u;
};


// Cache local pour fallback en cas d'erreur réseau
const DATA_CACHE_KEY = "agro_berry_data_cache_v1";
function saveDataCache(data, sha) {
  try { localStorage.setItem(DATA_CACHE_KEY, JSON.stringify({ data, sha, ts: Date.now() })); } catch {}
}
function loadDataCache() {
  try {
    const raw = localStorage.getItem(DATA_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

// Sleep helper
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchGitHubDataOnce() {
  // Récupérer les métadonnées (sha + download_url)
  const metaRes = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" }
  });
  if (!metaRes.ok) throw new Error("Erreur GitHub meta " + metaRes.status);
  const meta = await metaRes.json();

  // Lire le contenu via blob SHA (supporte > 1MB)
  const blobRes = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/blobs/${meta.sha}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.raw+json" }
  });
  if (!blobRes.ok) throw new Error("Erreur GitHub blob " + blobRes.status);
  const data = await blobRes.json();
  return { data, sha: meta.sha };
}

// Retry automatique : 3 tentatives avec délais croissants pour gérer les coupures réseau temporaires
async function fetchGitHubData() {
  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await fetchGitHubDataOnce();
      saveDataCache(result.data, result.sha); // cache pour fallback futur
      return result;
    } catch (err) {
      lastErr = err;
      console.warn(`[fetchGitHubData] Tentative ${attempt}/${MAX_ATTEMPTS} échouée:`, err.message);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(800 * attempt); // 800ms, 1600ms
      }
    }
  }
  throw lastErr;
}

async function saveMelangesConfig(farmName, melangesData) {
  // Sauvegarder dans localStorage immédiatement (UX : changement visible direct)
  try { 
    localStorage.setItem("melanges_" + farmName, JSON.stringify(melangesData));
    localStorage.setItem("melanges_cache", JSON.stringify(melangesData));
  } catch {}
  // === Phase 2A : Firestore primaire (rapide, sans 409), GitHub en arrière-plan ===
  await saveMelangesConfigToFirestore(farmName, melangesData);
  // GitHub en best-effort (ne bloque pas l'UI)
  githubPutWithRetry(
    async () => {
      const { data, sha } = await fetchGitHubData();
      if (!data.melangesConfig) data.melangesConfig = {};
      data.melangesConfig[farmName] = melangesData;
      return { data, sha };
    },
    `[CONFIG] melanges ${farmName}`,
    "Erreur sauvegarde config"
  ).catch(err => console.warn("⚠️ Sync GitHub melanges a échoué (non-critique):", err?.message || err));
}

// Helper réutilisable : effectue un PUT GitHub avec retry automatique sur conflit 409
// builderFn doit retourner {data, sha} (frais à chaque tentative)
async function githubPutWithRetry(builderFn, commitMessage, errPrefix = "Erreur GitHub", retries = 6) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data, sha } = await builderFn();
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
      const put = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ message: commitMessage, content, sha })
      });
      if (put.status === 409 && attempt < retries) {
        const delay = 200 + Math.random() * 300 * attempt;
        console.log(`🔄 Conflit GitHub 409 (${commitMessage}), retry ${attempt}/${retries} dans ${Math.round(delay)}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (!put.ok) throw new Error(`${errPrefix} ${put.status}`);
      return;
    } catch(e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
}

// ===========================================================================
// === FIRESTORE WRITES (Phase 2A — primary backend, no 409, no SHA conflict)
// ===========================================================================

// Écrit 1+ mouvements en Firestore. Le doc id = movement.id (numérique stable).
// Idempotent : un retry réécrit le même doc (pas de doublon).
async function saveToFirestore(movements) {
  const mvArray = Array.isArray(movements) ? movements : [movements];
  // Génère les IDs si manquants (cohérent avec saveToGitHub)
  const now = Date.now();
  const mvWithIds = mvArray.map((mv, i) => ({ ...mv, id: mv.id || (now + i) }));
  const batch = writeBatch(db);
  for (const mv of mvWithIds) {
    batch.set(doc(db, "movements", String(mv.id)), mv);
  }
  await batch.commit();
  return mvWithIds;
}

// Supprime un mouvement de Firestore par son id numérique.
async function deleteFromFirestore(mvId) {
  await deleteDoc(doc(db, "movements", String(mvId)));
}

// Met à jour partiellement un mouvement (édition date/quantité/etc.) en Firestore.
async function updateMovementInFirestore(mvId, updates) {
  await setDoc(doc(db, "movements", String(mvId)), updates, { merge: true });
}

// Sauvegarde la config mélanges d'une ferme dans Firestore.
// Schéma : melanges/{farmName} → { sol: {...}, horsSol: {...}, ... }
async function saveMelangesConfigToFirestore(farmName, melangesData) {
  await setDoc(doc(db, "melanges", farmName), melangesData, { merge: true });
}

// Supprime en batch une liste de mouvements (utilisé par la déduplication).
async function deleteMovementsBatch(mvIds) {
  if (!mvIds || mvIds.length === 0) return;
  const batchSize = 400;
  for (let i = 0; i < mvIds.length; i += batchSize) {
    const chunk = mvIds.slice(i, i + batchSize);
    const batch = writeBatch(db);
    for (const id of chunk) {
      batch.delete(doc(db, "movements", String(id)));
    }
    await batch.commit();
  }
}

// ===========================================================================
// === FIRESTORE READS (Phase 2B — primary read source, real-time)
// ===========================================================================

// Lecture one-shot de toutes les collections nécessaires en parallèle.
// Retourne un objet `data` au même format que ce que renvoyait fetchGitHubData.
async function fetchFirestoreData(farmName) {
  const [movsSnap, prodsSnap, invsSnap, stockInitSnap, melangesSnap] = await Promise.all([
    getDocs(collection(db, "movements")),
    getDocs(collection(db, "products")),
    getDocs(collection(db, "physicalInventories")),
    getDoc(doc(db, "config", "stockInitial")),
    getDoc(doc(db, "melanges", farmName)),
  ]);
  const stockInitData = stockInitSnap.exists() ? stockInitSnap.data() : {};
  const melangesForFarm = melangesSnap.exists() ? melangesSnap.data() : null;
  return {
    products: prodsSnap.docs.map(d => d.data()),
    movements: movsSnap.docs.map(d => d.data()),
    physicalInventories: invsSnap.docs.map(d => d.data()),
    stockAB1: stockInitData.stockAB1 || [],
    stockAB2: stockInitData.stockAB2 || [],
    stockAB3: stockInitData.stockAB3 || [],
    melangesConfig: melangesForFarm ? { [farmName]: melangesForFarm } : {},
  };
}


async function saveToGitHub(movements, retries = 6) {
  const mvArray = Array.isArray(movements) ? movements : [movements];
  // Générer les IDs AVANT la boucle de retry pour éviter les doublons
  // Si le 1er essai réussit mais la réponse réseau est perdue, le retry
  // détectera que ces IDs existent déjà et ne les re-ajoutera pas
  const now = Date.now();
  const mvWithIds = mvArray.map((mv, i) => ({ ...mv, id: now + i }));
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data, sha } = await fetchGitHubData();
      // Vérification idempotence : ne pas ajouter si l'ID existe déjà
      const existingIds = new Set(data.movements.map(m => m.id));
      const toAdd = mvWithIds.filter(mv => !existingIds.has(mv.id));
      if (toAdd.length === 0) return; // déjà sauvegardé lors d'un retry précédent
      toAdd.forEach(mv => data.movements.push(mv));
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
      const put = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ message: `[${mvWithIds[0].farm}] ${mvWithIds[0].type}: ${mvWithIds[0].product} ${mvWithIds[0].quantity}${mvWithIds[0].unit}`, content, sha })
      });
      if (put.status === 409 && attempt < retries) {
        // Conflit : SHA obsolète, quelqu'un d'autre a pushé entre-temps
        // Backoff court et aléatoire pour éviter que 2 clients retry en même temps
        const delay = 200 + Math.random() * 300 * attempt;
        console.log(`🔄 Conflit GitHub 409, retry ${attempt}/${retries} dans ${Math.round(delay)}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (!put.ok) throw new Error("Erreur écriture GitHub " + put.status);
      return; // succès
    } catch(e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
}

async function deleteFromGitHub(mvId, retries = 6) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data, sha } = await fetchGitHubData();
      const before = data.movements.length;
      data.movements = data.movements.filter(m => m.id !== mvId);
      if (data.movements.length === before) {
        // Si on est en retry, peut-être que c'était déjà supprimé lors d'une tentative précédente
        if (attempt > 1) return;
        throw new Error("Mouvement introuvable");
      }
      // Tracker l'ID supprimé (pour sync avec l'admin)
      if (!data.deletedMovementIds) data.deletedMovementIds = [];
      if (!data.deletedMovementIds.includes(mvId)) data.deletedMovementIds.push(mvId);
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
      const put = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ message: `[DELETE] mouvement ${mvId}`, content, sha })
      });
      if (put.status === 409 && attempt < retries) {
        const delay = 200 + Math.random() * 300 * attempt;
        console.log(`🔄 Conflit GitHub (delete) 409, retry ${attempt}/${retries} dans ${Math.round(delay)}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (!put.ok) throw new Error("Erreur suppression GitHub " + put.status);
      return;
    } catch(e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
}

function calcFarmStock(movements, farmName, stockInitial, physicalInventories) {
  try {
    // Trouver le dernier inventaire physique pour cette ferme
    const farmInvs = (physicalInventories || [])
      .filter(inv => inv.farm === farmName && inv.data && typeof inv.data === "object")
      .sort((a, b) => b.date.localeCompare(a.date));
    const latestInv = farmInvs[0];

    const stock = {};

    if (latestInv) {
      // Base = inventaire physique (comme l'app admin)
      Object.entries(latestInv.data).forEach(([product, qty]) => {
        const quantity = parseFloat(qty) || 0;
        if (quantity > 0) stock[product] = { product, unit: "KG", qty: quantity };
      });
      // Mouvements APRÈS la date d'inventaire (strictement après, comme l'admin)
      const invDate = latestInv.date;
      for (const mv of movements) {
        if (!mv.date || mv.date <= invDate) continue;
        const p = mv.product;
        if (!p) continue;
        if (!stock[p]) stock[p] = { product: p, unit: mv.unit || "KG", qty: 0 };
        if (mv.type === "exit"         && mv.farm === farmName) stock[p].qty += mv.quantity || 0;
        if (mv.type === "transfer-in"  && mv.farm === farmName) stock[p].qty += mv.quantity || 0;
        if (mv.type === "consumption"  && mv.farm === farmName) stock[p].qty -= mv.quantity || 0;
        if (mv.type === "transfer-out" && mv.farm === farmName) stock[p].qty -= mv.quantity || 0;
      }
    } else {
      // Pas d'inventaire physique → stockInitial + tous mouvements
      for (const s of (stockInitial || [])) {
        stock[s.product] = { product: s.product, unit: s.unit || "KG", qty: s.quantity || 0 };
      }
      for (const mv of movements) {
        const p = mv.product;
        if (!p) continue;
        if (!stock[p]) stock[p] = { product: p, unit: mv.unit || "KG", qty: 0 };
        if (mv.type === "exit"         && mv.farm === farmName) stock[p].qty += mv.quantity || 0;
        if (mv.type === "transfer-in"  && mv.farm === farmName) stock[p].qty += mv.quantity || 0;
        if (mv.type === "consumption"  && mv.farm === farmName) stock[p].qty -= mv.quantity || 0;
        if (mv.type === "transfer-out" && mv.farm === farmName) stock[p].qty -= mv.quantity || 0;
      }
    }

    // Plancher à 0 : le stock ne peut jamais être négatif
    return Object.values(stock)
      .map(s => ({ ...s, qty: Math.max(0, s.qty) }))
      .filter(s => s.qty > 0.001)
      .sort((a,b) => a.product.localeCompare(b.product));
  } catch(e) {
    console.error("calcFarmStock error:", e);
    return [];
  }
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
  const [allMovements, setAllMovements] = useState([]);
  const [physicalInventories, setPhysicalInventories] = useState([]);
  const [stockInitialAll, setStockInitialAll] = useState({});
  const [reportMonth, setReportMonth] = useState("AOUT");
  const [globalStockSearch, setGlobalStockSearch] = useState("");
  const [loadingStock, setLoadingStock] = useState(true);
  const [search, setSearch] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [customProduct, setCustomProduct] = useState(false);
  const [stockSearch, setStockSearch] = useState("");
  const [mvSearch, setMvSearch] = useState("");
  const [mvFilter, setMvFilter] = useState("all");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [melangesConfig, setMelangesConfig] = useState(() => {
    try {
      const cached = localStorage.getItem("melanges_cache");
      return cached ? JSON.parse(cached) : { horsSol: [], sol: [] };
    } catch { return { horsSol: [], sol: [] }; }
  });
  const [melangesSaving, setMelangesSaving] = useState(false);
  const [melangesSaved, setMelangesSaved] = useState(false);
  const autoDeduped = useRef(false); // Évite de relancer l'auto-dedup plusieurs fois par session

  const farmName = userInfo?.farm || "AGRO BERRY 1";
  const farmConfig = FARM_CONFIG[farmName] || FARM_CONFIG["AGRO BERRY 1"];
  const farmKey = farmName === "AGRO BERRY 1" ? "stockAB1" : farmName === "AGRO BERRY 2" ? "stockAB2" : "stockAB3";
  const MENUS = ALL_MENUS.filter(m => !m.farms || m.farms.includes(farmName));
  const emptyForm = { product:"", quantity:"", unit:"KG", culture:farmConfig.cultures[0], destination:"", supplier:"", price:"", toFarm:"", notes:"", date: new Date().toISOString().split("T")[0] };
  const [form, setForm] = useState(emptyForm);
  const fset = (k,v) => setForm(prev => ({ ...prev, [k]: v }));
  const destinations = farmConfig.destinations[form.culture] || [];

  const [loadError, setLoadError] = useState("");

  // === Phase 2B : lectures Firestore (primaire, temps réel) ===
  // loadData = refresh manuel one-shot (pour le bouton Actualiser)
  const loadData = () => {
    setLoadingStock(true);
    setLoadError("");
    fetchFirestoreData(farmName).then((data) => {
      setProducts([...data.products].sort((a,b) => a.name.localeCompare(b.name)));
      setFarmStock(calcFarmStock(data.movements, farmName, data[farmKey] || [], data.physicalInventories || []));
      setFarmMovements(getFarmMovements(data.movements, farmName));
      setAllMovements(data.movements || []);
      setPhysicalInventories(data.physicalInventories || []);
      setStockInitialAll({ stockAB1: data.stockAB1 || [], stockAB2: data.stockAB2 || [], stockAB3: data.stockAB3 || [] });
      setMelangesConfig(loadMelanges(data, farmName));
    }).catch(err => {
      console.error('Firestore error:', err);
      // Fallback : utiliser le cache local si disponible pour ne pas casser l'app
      const cached = loadDataCache();
      if (cached && cached.data) {
        const data = cached.data;
        setProducts([...(data.products || [])].sort((a,b) => a.name.localeCompare(b.name)));
        setFarmStock(calcFarmStock(data.movements || [], farmName, data[farmKey] || [], data.physicalInventories || []));
        setFarmMovements(getFarmMovements(data.movements || [], farmName));
        setAllMovements(data.movements || []);
        setPhysicalInventories(data.physicalInventories || []);
        setStockInitialAll({ stockAB1: data.stockAB1 || [], stockAB2: data.stockAB2 || [], stockAB3: data.stockAB3 || [] });
        setMelangesConfig(loadMelanges(data, farmName));
        const ageMin = Math.round((Date.now() - (cached.ts || 0)) / 60000);
        setLoadError(`⚠️ Connexion Firestore indisponible. Affichage du cache (il y a ${ageMin} min). Cliquez Actualiser pour réessayer.`);
      } else {
        setLoadError("⚠️ Erreur chargement : " + err.message + ". Vérifiez votre connexion internet et cliquez Actualiser.");
      }
    }).finally(() => setLoadingStock(false));
  };

  // === Phase 2B : Subscriptions temps réel ===
  // À chaque changement dans Firestore (ajout/suppression/modif), l'UI se met à jour automatiquement.
  // Plus besoin de F5 — quand l'admin saisit un mouvement, il apparaît instantanément ici.
  useEffect(() => {
    if (!farmName) return;
    setLoadingStock(true);
    setLoadError("");

    // État cumulatif des données reçues des différentes subscriptions
    const cache = { movements: [], products: [], physicalInventories: [], stockInitial: null, melanges: null };
    const loadedSet = new Set();
    const expectedKeys = ["movements", "products", "physicalInventories", "stockInitial", "melanges"];

    const updateUI = () => {
      setProducts([...cache.products].sort((a,b) => a.name.localeCompare(b.name)));
      const stockInitForFarm = cache.stockInitial?.[farmKey] || [];
      setFarmStock(calcFarmStock(cache.movements, farmName, stockInitForFarm, cache.physicalInventories || []));
      setFarmMovements(getFarmMovements(cache.movements, farmName));
      setAllMovements(cache.movements);
      setPhysicalInventories(cache.physicalInventories || []);
      setStockInitialAll({ stockAB1: cache.stockInitial?.stockAB1 || [], stockAB2: cache.stockInitial?.stockAB2 || [], stockAB3: cache.stockInitial?.stockAB3 || [] });
      const wrappedMelanges = cache.melanges ? { melangesConfig: { [farmName]: cache.melanges } } : { melangesConfig: {} };
      setMelangesConfig(loadMelanges(wrappedMelanges, farmName));
      // Stop le spinner dès que les 5 subscriptions ont chargé au moins une fois
      if (expectedKeys.every(k => loadedSet.has(k))) setLoadingStock(false);
    };

    const handleErr = (label) => (err) => {
      console.error(`onSnapshot ${label}:`, err);
      setLoadError(`⚠️ Erreur Firestore (${label}): ${err.message}. Cliquez Actualiser pour réessayer.`);
      setLoadingStock(false);
    };

    const unsubs = [
      onSnapshot(collection(db, "movements"), snap => {
        cache.movements = snap.docs.map(d => d.data());
        loadedSet.add("movements"); updateUI();
      }, handleErr("movements")),
      onSnapshot(collection(db, "products"), snap => {
        cache.products = snap.docs.map(d => d.data());
        loadedSet.add("products"); updateUI();
      }, handleErr("products")),
      onSnapshot(collection(db, "physicalInventories"), snap => {
        cache.physicalInventories = snap.docs.map(d => d.data());
        loadedSet.add("physicalInventories"); updateUI();
      }, handleErr("physicalInventories")),
      onSnapshot(doc(db, "config", "stockInitial"), snap => {
        cache.stockInitial = snap.exists() ? snap.data() : {};
        loadedSet.add("stockInitial"); updateUI();
      }, handleErr("stockInitial")),
      onSnapshot(doc(db, "melanges", farmName), snap => {
        cache.melanges = snap.exists() ? snap.data() : null;
        loadedSet.add("melanges"); updateUI();
      }, handleErr("melanges")),
    ];

    // Cleanup à l'unmount ou au changement de ferme
    return () => unsubs.forEach(u => { try { u(); } catch {} });
  }, [farmName, farmKey]);

  // === Auto-correction des stocks négatifs (doublons) ===
  // Si un produit passe en négatif (signe de doublon), suppression silencieuse au 1er chargement.
  useEffect(() => {
    if (!allMovements.length || autoDeduped.current || loadingStock) return;
    const hasNegatives = farmStock.some(s => s.qty < 0);
    if (!hasNegatives) return;
    autoDeduped.current = true;
    const seen = new Set();
    const dupeIds = [];
    for (const mv of allMovements) {
      const key = `${mv.farm}|${mv.type}|${mv.product}|${mv.quantity}|${mv.date}|${mv.destination||""}|${mv.culture||""}`;
      if (seen.has(key)) dupeIds.push(mv.id);
      else seen.add(key);
    }
    if (!dupeIds.length) return;
    deleteMovementsBatch(dupeIds)
      .then(() => {
        // Sync GitHub en arrière-plan (non-bloquant)
        githubPutWithRetry(
          async () => {
            const { data, sha } = await fetchGitHubData();
            const dupeSet = new Set(dupeIds.map(String));
            data.movements = data.movements.filter(m => !dupeSet.has(String(m.id)));
            return { data, sha };
          },
          `[AUTO-FIX] Suppression ${dupeIds.length} doublons`,
          "Erreur GitHub"
        ).catch(err => console.warn("⚠️ Auto-dedup sync GitHub:", err?.message || err));
        loadData();
      })
      .catch(err => console.warn("⚠️ Auto-dedup Firestore:", err?.message || err));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farmStock, allMovements, loadingStock]);

  const filtered = products.filter(p => p.name.toLowerCase().includes(search.toLowerCase())).slice(0,25);
  const filteredStock = farmStock.filter(s => s.product.toLowerCase().includes(stockSearch.toLowerCase()));
  const positiveStock = filteredStock.filter(s => s.qty > 0);
  const negativeStock = filteredStock.filter(s => s.qty < 0);

  const [mvDateFrom, setMvDateFrom] = useState("");
  const [mvDateTo, setMvDateTo] = useState("");
  const [mvPage, setMvPage] = useState(1);
  const [deletingId, setDeletingId] = useState(null);
  const [editingMv, setEditingMv] = useState(null); // mouvement en cours d'édition
  const [editDate, setEditDate] = useState("");
  const MV_PER_PAGE = 20;

  const filteredMv = farmMovements.filter(mv => {
    const matchSearch = !mvSearch || mv.product?.toLowerCase().includes(mvSearch.toLowerCase());
    const matchFilter = mvFilter === "all" || mv.type === mvFilter ||
      (mvFilter === "entry" && mv.type === "exit");
    const matchFrom = !mvDateFrom || mv.date >= mvDateFrom;
    const matchTo = !mvDateTo || mv.date <= mvDateTo;
    return matchSearch && matchFilter && matchFrom && matchTo;
  });
  const mvTotalPages = Math.ceil(filteredMv.length / MV_PER_PAGE);
  const paginatedMv = filteredMv.slice((mvPage - 1) * MV_PER_PAGE, mvPage * MV_PER_PAGE);

  const handleSelectProduct = (p) => {
    fset("product", p.name); fset("unit", cleanUnit(p.unit));
    setSearch(p.name); setShowDropdown(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true); setError("");
    try {
      const today = form.date || new Date().toISOString().split("T")[0];
      const qty = parseFloat(form.quantity);
      
      // Bloquer si consommation > stock disponible
      if (active === "consumption" && form.product) {
        const stockItem = farmStock.find(s => s.product.toUpperCase() === form.product.toUpperCase());
        const stockQty = stockItem ? Math.max(0, stockItem.qty) : 0;
        if (qty > stockQty + 0.001) {
          setError("Stock insuffisant — disponible : " + (stockQty % 1 === 0 ? stockQty : stockQty.toFixed(2)) + " " + (stockItem?.unit || form.unit));
          setLoading(false);
          return;
        }
      }

      // Bloquer si destination non sélectionnée pour consommation
      if (active === "consumption" && !form.destination) {
        setError("Veuillez sélectionner une destination.");
        setLoading(false);
        return;
      }
      
      const mv = { type: active === "transfer" ? "transfer-out" : active, product: form.product, quantity: qty, unit: form.unit, farm: farmName, date: today };
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

      // === Phase 2A : Firestore primaire (rapide, sans 409), GitHub en arrière-plan ===
      const savedMvs = await saveToFirestore(mouvementsToSave);
      // GitHub continue à recevoir les écritures pour la période de transition (1 semaine)
      // Si GitHub échoue (409 ou autre), on log seulement — l'utilisateur n'est pas bloqué
      saveToGitHub(savedMvs).catch(err => console.warn("⚠️ Sync GitHub a échoué (non-critique):", err?.message || err));
      loadData(); // Recharger pour rafraîchir l'affichage
      setSuccess(true); setForm(emptyForm); setSearch(""); setCustomProduct(false);
      setTimeout(() => setSuccess(false), 4000);
    } catch(err) { setError(err.message); }
    setLoading(false);
  };

  const handleDelete = async (mv) => {
    if (!window.confirm(`Supprimer ce mouvement ?\n${mv.product} — ${mv.type} — ${mv.quantity} ${mv.unit}`)) return;
    setDeletingId(mv.id);
    try {
      // Supprimer de Firestore (primaire) et GitHub (background)
      await deleteFromFirestore(mv.id);
      deleteFromGitHub(mv.id).catch(err => console.warn("⚠️ Sync GitHub delete a échoué (non-critique):", err?.message || err));
      // Mettre à jour les listes locales immédiatement
      setFarmMovements(prev => prev.filter(m => m.id !== mv.id));
      setAllMovements(prev => prev.filter(m => m.id !== mv.id));
      // Recharger le stock depuis Firestore pour un recalcul exact
      loadData();
    } catch(err) { alert("Erreur suppression : " + err.message); }
    setDeletingId(null);
  };

  const handleDeduplication = async () => {
    if (!window.confirm("Supprimer les mouvements en double ?\n\nSeul le premier exemplaire de chaque doublon sera conservé.\nCela corrigera les stocks négatifs causés par les doublons.")) return;
    setLoadingStock(true);
    try {
      // === Phase 2A : on utilise allMovements (déjà chargé en mémoire depuis GitHub)
      // pour identifier les doublons, puis on supprime de Firestore + GitHub
      const seen = new Set();
      const dupeIds = [];
      for (const mv of allMovements) {
        const key = `${mv.farm}|${mv.type}|${mv.product}|${mv.quantity}|${mv.date}|${mv.destination||""}|${mv.culture||""}`;
        if (seen.has(key)) {
          dupeIds.push(mv.id);
        } else {
          seen.add(key);
        }
      }
      const removed = dupeIds.length;
      if (removed === 0) {
        alert("Aucun doublon trouvé !");
        setLoadingStock(false);
        return;
      }
      // Firestore : suppression batch (rapide, sans 409)
      await deleteMovementsBatch(dupeIds);
      // GitHub : best-effort en arrière-plan
      githubPutWithRetry(
        async () => {
          const { data, sha } = await fetchGitHubData();
          const dupeSet = new Set(dupeIds.map(String));
          data.movements = data.movements.filter(m => !dupeSet.has(String(m.id)));
          return { data, sha };
        },
        `[FIX] Suppression ${removed} doublons`,
        "Erreur GitHub"
      ).catch(err => console.warn("⚠️ Sync GitHub déduplication a échoué (non-critique):", err?.message || err));
      alert(`✅ ${removed} doublon(s) supprimé(s) ! Le stock va se recalculer.`);
      loadData();
    } catch(err) {
      alert("Erreur dédoublonnage : " + err.message);
      setLoadingStock(false);
    }
  };

  const exportExcel = (headers, rows, filename) => {
    const BOM = "\uFEFF";
    const csvContent = BOM + [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(";")).join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportMouvementsExcel = (mvList, farmNm) => {
    const date = new Date().toLocaleDateString("fr-FR", {day:"2-digit",month:"long",year:"numeric"});
    const entries = mvList.filter(m => m.type === "exit").length;
    const consos = mvList.filter(m => m.type === "consumption").length;
    const transfers = mvList.filter(m => m.type === "transfer-out" || m.type === "transfer-in").length;

    const typeLabel = (mv) => {
      if (mv.type === "exit") return "Entree magasin";
      if (mv.type === "consumption") return "Consommation";
      if (mv.type === "transfer-out") return "Transfert sortant";
      if (mv.type === "transfer-in") return "Transfert entrant";
      return mv.type;
    };
    const typeColor = (mv) => {
      if (mv.type === "exit") return theme.primary;
      if (mv.type === "consumption") return "#dc2626";
      if (mv.type === "transfer-out" || mv.type === "transfer-in") return "#7c3aed";
      return "#1d1d1f";
    };
    const isPlus = (mv) => mv.type === "exit" || mv.type === "transfer-in";

    const rows = mvList.map(mv => `
      <tr style="border-bottom:1px solid #f0f0f0">
        <td style="padding:9px 12px;font-size:12px;color:#6e6e73;white-space:nowrap">${mv.date}</td>
        <td style="padding:9px 12px;font-size:13px;font-weight:600;color:#1d1d1f">${mv.product}</td>
        <td style="padding:9px 12px;font-size:11px;color:#86868b">${mv.unit||""}</td>
        <td style="padding:9px 12px">
          <span style="background:${typeColor(mv)}18;color:${typeColor(mv)};font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;white-space:nowrap">${typeLabel(mv)}</span>
        </td>
        <td style="padding:9px 12px;text-align:right;font-size:14px;font-weight:800;color:${isPlus(mv)?"#16a34a":"#dc2626"};font-family:monospace">
          ${isPlus(mv)?"+":"-"}${mv.quantity%1===0?mv.quantity:parseFloat(mv.quantity).toFixed(2)}
        </td>
        <td style="padding:9px 12px;font-size:12px;color:#6e6e73">
          ${mv.culture?mv.culture+(mv.destination?" · "+mv.destination:""):mv.toFarm?mv.toFarm.replace("AGRO BERRY ","AB"):mv.autoFrom?"← "+mv.autoFrom.replace("AGRO BERRY ","AB"):"—"}
        </td>
      </tr>`).join("");

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>Mouvements ${farmNm}</title>
    <style>
      body{font-family:'Helvetica Neue',Arial,sans-serif;margin:0;padding:30px;color:#1d1d1f;background:#fff}
      .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;padding-bottom:20px;border-bottom:3px solid ${theme.bright}}
      .logo{font-size:26px;font-weight:900;color:${theme.bright};letter-spacing:-1px}
      .subtitle{font-size:13px;color:#86868b;margin-top:4px}
      .meta{text-align:right}
      .meta .farm{font-size:18px;font-weight:700;color:#1d1d1f}
      .meta .dt{font-size:12px;color:#86868b;margin-top:4px}
      .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:28px}
      .stat{border-radius:12px;padding:16px 20px}
      .stat-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
      .stat-value{font-size:28px;font-weight:800}
      .stat-sub{font-size:11px;margin-top:4px}
      table{width:100%;border-collapse:collapse}
      thead tr{background:#f5f5f7}
      th{padding:10px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#6e6e73;border-bottom:2px solid #e5e7eb}
      tr:nth-child(even){background:#fafafa}
      .footer{margin-top:28px;padding-top:16px;border-top:1px solid #e5e7eb;display:flex;justify-content:space-between;font-size:11px;color:#86868b}
      @media print{body{padding:15px}.stats{gap:10px}}
    </style></head><body>
    <div class="header">
      <div>
        <div class="logo">🫐 Agro Berry</div>
        <div class="subtitle">Rapport Mouvements</div>
      </div>
      <div class="meta">
        <div class="farm">${farmNm}</div>
        <div class="dt">${date}</div>
      </div>
    </div>
    <div class="stats">
      <div class="stat" style="background:linear-gradient(135deg,${theme.bgLight},${theme.bgMedium})">
        <div class="stat-label" style="color:${theme.darkest}">Entrées magasin</div>
        <div class="stat-value" style="color:${theme.primary}">${entries}</div>
        <div class="stat-sub" style="color:#86868b">opérations</div>
      </div>
      <div class="stat" style="background:linear-gradient(135deg,#fff5f5,#fee2e2)">
        <div class="stat-label" style="color:#b91c1c">Consommations</div>
        <div class="stat-value" style="color:#dc2626">${consos}</div>
        <div class="stat-sub" style="color:#86868b">opérations</div>
      </div>
      <div class="stat" style="background:linear-gradient(135deg,#f5f3ff,#ede9fe)">
        <div class="stat-label" style="color:#6d28d9">Transferts</div>
        <div class="stat-value" style="color:#7c3aed">${transfers}</div>
        <div class="stat-sub" style="color:#86868b">opérations</div>
      </div>
      <div class="stat" style="background:#f5f5f7">
        <div class="stat-label" style="color:#6e6e73">Total</div>
        <div class="stat-value" style="color:#1d1d1f">${mvList.length}</div>
        <div class="stat-sub" style="color:#86868b">mouvements</div>
      </div>
    </div>
    <table>
      <thead><tr>
        <th>Date</th><th>Produit</th><th>Unite</th><th>Type</th>
        <th style="text-align:right">Quantite</th><th>Detail</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="footer">
      <span>Agro Berry Magasinier — ${farmNm}</span>
      <span>${mvList.length} mouvements exportés le ${date}</span>
    </div>
    <script>window.onload=function(){window.print()}<\/script>
    </body></html>`;

    const w = window.open("","_blank");
    w.document.write(html);
    w.document.close();
  };

  const handleEditDate = async () => {
    if (!editingMv || !editDate) return;
    setDeletingId(editingMv.id);
    try {
      const updates = {
        date: editDate,
        product: editingMv.product,
        quantity: parseFloat(editingMv.quantity) || editingMv.quantity,
        unit: editingMv.unit || "KG",
      };
      // === Phase 2A : Firestore primaire (rapide, sans 409), GitHub en arrière-plan ===
      await updateMovementInFirestore(editingMv.id, updates);
      githubPutWithRetry(
        async () => {
          const { data, sha } = await fetchGitHubData();
          const idx = data.movements.findIndex(m => m.id === editingMv.id);
          if (idx >= 0) data.movements[idx] = { ...data.movements[idx], ...updates };
          return { data, sha };
        },
        `[EDIT] ${editingMv.product}`,
        "Erreur GitHub"
      ).catch(err => console.warn("⚠️ Sync GitHub edit a échoué (non-critique):", err?.message || err));
      setFarmMovements(prev => prev.map(m => m.id === editingMv.id ? { 
        ...m, date: editDate, product: editingMv.product, 
        quantity: parseFloat(editingMv.quantity)||m.quantity, unit: editingMv.unit||m.unit 
      } : m));
      setEditingMv(null);
    } catch(err) { alert("Erreur : " + err.message); }
    setDeletingId(null);
  };

  const activeMenu = MENUS.find(m => m.id === active);
  const farmEmoji = farmName.includes("1") ? "🌿" : farmName.includes("2") ? "🫐" : "🫐";
  const farmShort = farmName.replace("AGRO BERRY ", "AB");
  const now = new Date();
  const dateStr = now.toLocaleDateString("fr-FR", { weekday:"short", day:"2-digit", month:"short", year:"numeric" });

  // Thème de couleur actif basé sur la ferme connectée (Bleu myrtille / Magenta / Sauge)
  const theme = FARM_THEMES[farmName] || FARM_THEMES["AGRO BERRY 3"];

  const css = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Space+Mono:wght@400;700&display=swap');
    :root {
      --theme-primary: ${theme.primary};
      --theme-bright:  ${theme.bright};
      --theme-dark:    ${theme.dark};
      --theme-darkest: ${theme.darkest};
      --theme-bg:      ${theme.bgLight};
      --theme-bg-med:  ${theme.bgMedium};
      --theme-rgb:     ${theme.rgb};
      --theme-rgb-l:   ${theme.rgbLight};
    }
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Inter',sans-serif; background:#f5f5f7; color:#1d1d1f; }
    .app { display:flex; min-height:100vh; }

    /* ── SIDEBAR ── */
    .sidebar { width:240px; background:linear-gradient(180deg,var(--theme-bright) 0%,var(--theme-primary) 100%); display:flex; flex-direction:column; position:fixed; top:0; left:0; height:100vh; z-index:100; transition:width 0.3s cubic-bezier(0.4,0,0.2,1); box-shadow:2px 0 12px rgba(var(--theme-rgb),0.15); }
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
    .date-chip { background:linear-gradient(135deg,var(--theme-bg),var(--theme-bg-med)); border:1px solid rgba(var(--theme-rgb-l),0.3); padding:6px 12px; border-radius:20px; font-size:11px; color:var(--theme-primary); font-weight:600; font-family:'Space Mono',monospace; }
    .page { padding:28px 32px; animation:fadeIn 0.3s ease; }
    @keyframes fadeIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }

    /* ── STOCK PAGE ── */
    .stock-header { display:flex; align-items:center; gap:16px; margin-bottom:24px; flex-wrap:wrap; }
    .stock-search { flex:1; min-width:200px; background:#fff; border:1px solid rgba(0,0,0,0.1); border-radius:12px; padding:10px 16px; font-size:13px; color:#1d1d1f; font-family:'Inter',sans-serif; outline:none; transition:all 0.2s; box-shadow:0 1px 4px rgba(0,0,0,0.04); }
    .stock-search:focus { border-color:rgba(var(--theme-rgb-l),0.5); box-shadow:0 0 0 3px rgba(var(--theme-rgb-l),0.1); }
    .stock-search::placeholder { color:#86868b; }
    .refresh-btn { padding:10px 16px; background:var(--theme-primary); border:none; border-radius:12px; color:#fff; font-size:13px; cursor:pointer; font-weight:600; font-family:'Inter',sans-serif; transition:all 0.2s; display:flex; align-items:center; gap:6px; box-shadow:0 2px 8px rgba(var(--theme-rgb-l),0.3); }
    .refresh-btn:hover { background:var(--theme-dark); transform:translateY(-1px); }
    .stock-stats { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:24px; }
    .stat-card { background:linear-gradient(135deg,var(--theme-bg),var(--theme-bg-med)); border:1px solid rgba(var(--theme-rgb-l),0.2); border-radius:14px; padding:16px 20px; }
    .stat-label { font-size:11px; color:#6e6e73; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px; font-weight:600; }
    .stat-value { font-size:26px; font-weight:700; color:#1d1d1f; font-family:'Space Mono',monospace; letter-spacing:-1px; }
    .stat-value.green { color:#16a34a; }
    .stat-value.red { color:#dc2626; }
    .stock-table { background:#fff; border:1px solid rgba(0,0,0,0.08); border-radius:16px; overflow:hidden; box-shadow:0 1px 6px rgba(0,0,0,0.04); }
    .stock-table-header { display:grid; grid-template-columns:1fr 80px 120px; padding:12px 20px; background:#f5f5f7; border-bottom:1px solid rgba(0,0,0,0.08); font-size:10px; font-weight:700; color:#6e6e73; text-transform:uppercase; letter-spacing:0.08em; }
    .stock-row { display:grid; grid-template-columns:1fr 80px 120px; padding:13px 20px; border-bottom:1px solid rgba(0,0,0,0.05); transition:background 0.15s; align-items:center; }
    .stock-row:last-child { border-bottom:none; }
    .stock-row:hover { background:var(--theme-bg); }
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
    .form-input:focus { border-color:rgba(var(--theme-rgb-l),0.5); background:#fff; box-shadow:0 0 0 3px rgba(var(--theme-rgb-l),0.1); }
    .form-input::placeholder { color:#86868b; }
    .form-input option { background:#fff; color:#1d1d1f; }
    .type-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .type-btn { padding:11px 14px; border-radius:12px; border:1px solid rgba(0,0,0,0.1); background:#f5f5f7; cursor:pointer; font-size:12px; font-weight:500; color:#6e6e73; text-align:left; font-family:'Inter',sans-serif; transition:all 0.2s; display:flex; align-items:center; gap:8px; }
    .type-btn:hover { border-color:rgba(var(--theme-rgb-l),0.3); color:#1d1d1f; background:var(--theme-bg); }
    .type-btn.active { border-color:currentColor; background:var(--theme-bg); color:var(--theme-primary); }
    .product-wrap { position:relative; }
    .product-dropdown { position:absolute; top:calc(100% + 6px); left:0; right:0; background:#fff; border:1px solid rgba(0,0,0,0.1); border-radius:14px; max-height:240px; overflow-y:auto; z-index:200; box-shadow:0 12px 40px rgba(0,0,0,0.12); padding:4px; }
    .product-item { padding:10px 14px; border-radius:10px; cursor:pointer; display:flex; justify-content:space-between; align-items:center; transition:background 0.15s; font-size:13px; }
    .product-item:hover { background:var(--theme-bg); }
    .product-name { color:#1d1d1f; font-weight:500; }
    .product-meta { font-size:11px; color:#86868b; font-family:'Space Mono',monospace; }
    .product-add { padding:10px 14px; border-radius:10px; cursor:pointer; color:var(--theme-primary); font-size:12px; font-weight:600; border-top:1px solid rgba(0,0,0,0.06); margin-top:4px; display:flex; align-items:center; gap:8px; transition:background 0.15s; }
    .product-add:hover { background:var(--theme-bg); }
    .back-link { font-size:11px; color:#86868b; background:none; border:none; cursor:pointer; padding:4px 0; text-decoration:underline; font-family:'Inter',sans-serif; }
    .submit-btn { width:100%; padding:14px; border:none; border-radius:13px; font-size:14px; font-weight:600; cursor:pointer; font-family:'Inter',sans-serif; transition:all 0.2s; display:flex; align-items:center; justify-content:center; gap:10px; letter-spacing:-0.2px; margin-top:8px; }
    .submit-btn:hover:not(:disabled) { transform:translateY(-1px); box-shadow:0 8px 24px rgba(var(--theme-rgb-l),0.3); }
    .submit-btn:disabled { opacity:0.5; cursor:not-allowed; transform:none; }
    .alert { padding:14px 16px; border-radius:12px; margin-bottom:20px; font-size:13px; font-weight:500; display:flex; align-items:center; gap:10px; }
    .alert.success { background:linear-gradient(135deg,var(--theme-bg),var(--theme-bg-med)); border:1px solid rgba(var(--theme-rgb-l),0.3); color:var(--theme-primary); }
    .alert.error { background:#fff5f5; border:1px solid rgba(220,38,38,0.2); color:#dc2626; }

    /* ── MOVEMENTS ── */
    .mv-header { display:flex; align-items:center; gap:12px; margin-bottom:20px; flex-wrap:wrap; }
    .mv-filters { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:20px; }
    .mv-filter-btn { padding:7px 14px; border-radius:20px; border:1px solid rgba(0,0,0,0.1); background:#fff; color:#6e6e73; font-size:12px; font-weight:500; cursor:pointer; font-family:'Inter',sans-serif; transition:all 0.2s; }
    .mv-filter-btn:hover { border-color:rgba(var(--theme-rgb-l),0.3); color:var(--theme-primary); background:var(--theme-bg); }
    .mv-filter-btn.active { background:var(--theme-primary); border-color:var(--theme-primary); color:#fff; font-weight:600; }
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
    ::-webkit-scrollbar-thumb { background:rgba(var(--theme-rgb-l),0.3); border-radius:4px; }
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
                {m.id === "alerts" && (() => {
                  const count = Object.entries(calcSeuils(melangesConfig)).filter(([name, seuil]) => {
                    const s = farmStock.find(x => x.product.toUpperCase() === name.toUpperCase());
                    const qty = s ? s.qty : 0;
                    return qty < seuil.qty;
                  }).length;                  return count > 0 ? <span className="nav-badge" style={{background:"#dc2626"}}>{count}</span> : null;
                })()}
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
                  <div className="stat-label">Total</div>
                  <div className="stat-value">{loadingStock ? "—" : positiveStock.length}</div>
                </div>
              </div>
              {loadError && (
                <div style={{background:"#fef2f2",border:"1px solid #fecaca",borderRadius:12,padding:"12px 16px",marginBottom:16,color:"#dc2626",fontSize:13,fontWeight:500}}>
                  {loadError}
                </div>
              )}
              <div className="stock-header">
                <input className="stock-search" placeholder="Rechercher un produit..." value={stockSearch} onChange={e => setStockSearch(e.target.value)} />
                <button className="refresh-btn" onClick={loadData}>
                  <span className={loadingStock ? "loading-spin" : ""}>↻</span> Actualiser
                </button>

                <button className="refresh-btn" style={{background:"var(--theme-primary)",border:"none",color:"#fff",fontWeight:600}} onClick={() => {
                  // Calcul prix moyen pondéré par produit depuis les mouvements 'entry' avec un prix
                  const priceMap = {};
                  for (const m of allMovements) {
                    if (m.type !== "entry") continue;
                    const prix = parseFloat(m.price);
                    const qty = parseFloat(m.quantity);
                    if (!prix || !qty || prix <= 0 || qty <= 0) continue;
                    const key = (m.product || "").toUpperCase();
                    if (!priceMap[key]) priceMap[key] = { totalValue: 0, totalQty: 0 };
                    priceMap[key].totalValue += prix * qty;
                    priceMap[key].totalQty += qty;
                  }
                  const getPrice = (productName) => {
                    const p = priceMap[(productName || "").toUpperCase()];
                    if (p && p.totalQty > 0) return p.totalValue / p.totalQty;
                    const productInfo = products.find(pp => pp.name?.toUpperCase() === productName?.toUpperCase());
                    return parseFloat(productInfo?.price) || 0;
                  };

                  // Préparer les données + totaux
                  let totalValeur = 0;
                  let countWithPrice = 0;
                  let countMissing = 0;
                  const rowsData = positiveStock.map(s => {
                    const prix = getPrice(s.product);
                    const qty = parseFloat(s.qty) || 0;
                    const valeur = prix * qty;
                    if (prix > 0) { totalValeur += valeur; countWithPrice++; } else { countMissing++; }
                    return { product: s.product, unit: cleanUnit(s.unit), qty, prix, valeur, hasPrice: prix > 0 };
                  });

                  const dateStr = new Date().toLocaleDateString("fr-FR", { weekday:"long", day:"2-digit", month:"long", year:"numeric" });
                  const fileDate = new Date().toISOString().split("T")[0];

                  // === Palette latte (couleurs SANS le # pour xlsx-js-style) ===
                  const COFFEE_DARK  = "3E2C1F";
                  const COFFEE       = "6B4F35";
                  const COFFEE_LIGHT = "8B6F47";
                  const CARAMEL      = "C9A66B";
                  const CARAMEL_TXT  = "D4B896";
                  const CREAM        = "FFF8E7";
                  const CREAM_LIGHT  = "F9F5EE";
                  const WHITE        = "FFFFFF";
                  const BORDER       = "E8DFCE";
                  const MUTED        = "A89B86";

                  // === Construire la feuille (AOA = Array of Arrays) ===
                  const aoa = [];
                  // Ligne 0 : titre principal
                  aoa.push(["🫐 Agro Berry", "", "", "", "", ""]);
                  // Ligne 1 : sous-titre
                  aoa.push([`Rapport de stock — ${farmName}`, "", "", "", "", ""]);
                  // Ligne 2 : date
                  aoa.push([`📅 ${dateStr}`, "", "", "", "", ""]);
                  // Ligne 3 : badge stats
                  const statsTxt = `📦 ${rowsData.length} produits   💰 ${totalValeur.toLocaleString("fr-FR",{minimumFractionDigits:2,maximumFractionDigits:2})} MAD${countMissing > 0 ? `   ⚠️ ${countMissing} sans prix` : ""}`;
                  aoa.push([statsTxt, "", "", "", "", ""]);
                  // Ligne 4 : spacer
                  aoa.push(["", "", "", "", "", ""]);
                  // Ligne 5 : headers
                  aoa.push(["Ferme","Produit","Unité","Quantité","Prix unit. (MAD)","Valeur (MAD)"]);
                  // Lignes 6+ : data
                  rowsData.forEach(r => {
                    aoa.push([
                      farmName,
                      r.product,
                      r.unit,
                      r.qty,
                      r.hasPrice ? r.prix : "À renseigner",
                      r.hasPrice ? r.valeur : "À renseigner"
                    ]);
                  });
                  // Ligne total
                  const totalRowIdx = aoa.length;
                  aoa.push(["", "", "", "", "TOTAL GÉNÉRAL", totalValeur]);

                  const ws = XLSXStyle.utils.aoa_to_sheet(aoa);

                  // === Largeur des colonnes ===
                  ws["!cols"] = [
                    { wch: 18 }, { wch: 32 }, { wch: 8 }, { wch: 12 }, { wch: 18 }, { wch: 18 }
                  ];

                  // === Hauteur des lignes ===
                  ws["!rows"] = [
                    { hpx: 36 }, // titre
                    { hpx: 22 }, // sous-titre
                    { hpx: 22 }, // date
                    { hpx: 28 }, // badge
                    { hpx: 8  }, // spacer
                    { hpx: 28 }, // headers
                  ];
                  for (let i = 6; i < totalRowIdx; i++) ws["!rows"].push({ hpx: 22 });
                  ws["!rows"].push({ hpx: 32 }); // total

                  // === Fusions ===
                  ws["!merges"] = [
                    { s: { r:0, c:0 }, e: { r:0, c:5 } }, // titre
                    { s: { r:1, c:0 }, e: { r:1, c:5 } }, // sous-titre
                    { s: { r:2, c:0 }, e: { r:2, c:5 } }, // date
                    { s: { r:3, c:0 }, e: { r:3, c:5 } }, // badge
                    { s: { r:4, c:0 }, e: { r:4, c:5 } }, // spacer
                  ];

                  // === Helpers de style ===
                  const border = (color = BORDER, style = "thin") => ({
                    top:    { style, color: { rgb: color } },
                    bottom: { style, color: { rgb: color } },
                    left:   { style, color: { rgb: color } },
                    right:  { style, color: { rgb: color } },
                  });

                  // Titre (row 0)
                  ws["A1"].s = {
                    font: { name: "Calibri", sz: 22, bold: true, color: { rgb: CREAM } },
                    fill: { fgColor: { rgb: COFFEE } },
                    alignment: { horizontal: "left", vertical: "center", indent: 1 }
                  };
                  // Sous-titre (row 1)
                  ws["A2"].s = {
                    font: { name: "Calibri", sz: 12, color: { rgb: CARAMEL_TXT } },
                    fill: { fgColor: { rgb: COFFEE } },
                    alignment: { horizontal: "left", vertical: "center", indent: 1 }
                  };
                  // Date (row 2)
                  ws["A3"].s = {
                    font: { name: "Calibri", sz: 11, color: { rgb: CARAMEL_TXT } },
                    fill: { fgColor: { rgb: COFFEE_DARK } },
                    alignment: { horizontal: "left", vertical: "center", indent: 1 }
                  };
                  // Badge stats (row 3)
                  ws["A4"].s = {
                    font: { name: "Calibri", sz: 12, bold: true, color: { rgb: COFFEE_DARK } },
                    fill: { fgColor: { rgb: CARAMEL } },
                    alignment: { horizontal: "left", vertical: "center", indent: 1 }
                  };
                  // Spacer (row 4) — pas de fill spécifique, transparent

                  // Headers (row 5)
                  const headerCols = ["A","B","C","D","E","F"];
                  const headerAligns = ["left","left","center","right","right","right"];
                  headerCols.forEach((col, idx) => {
                    const cell = ws[`${col}6`];
                    if (!cell) return;
                    cell.s = {
                      font: { name: "Calibri", sz: 11, bold: true, color: { rgb: CREAM } },
                      fill: { fgColor: { rgb: COFFEE_DARK } },
                      alignment: { horizontal: headerAligns[idx], vertical: "center", indent: 1 },
                      border: border(COFFEE_DARK)
                    };
                  });

                  // Data rows (rows 6 → totalRowIdx-1)
                  for (let i = 6; i < totalRowIdx; i++) {
                    const isAlt = (i - 6) % 2 === 1;
                    const bg = isAlt ? CREAM_LIGHT : WHITE;
                    const r = rowsData[i - 6];
                    const styleBase = {
                      font: { name: "Calibri", sz: 11, color: { rgb: COFFEE_DARK } },
                      fill: { fgColor: { rgb: bg } },
                      border: border(BORDER)
                    };
                    // A: Ferme
                    if (ws[`A${i+1}`]) ws[`A${i+1}`].s = { ...styleBase, font: { ...styleBase.font, color: { rgb: COFFEE } }, alignment: { horizontal: "left", vertical: "center", indent: 1 } };
                    // B: Produit
                    if (ws[`B${i+1}`]) ws[`B${i+1}`].s = { ...styleBase, font: { ...styleBase.font, bold: true }, alignment: { horizontal: "left", vertical: "center", indent: 1 } };
                    // C: Unité
                    if (ws[`C${i+1}`]) ws[`C${i+1}`].s = { ...styleBase, font: { ...styleBase.font, color: { rgb: COFFEE_LIGHT } }, alignment: { horizontal: "center", vertical: "center" } };
                    // D: Quantité
                    if (ws[`D${i+1}`]) {
                      ws[`D${i+1}`].s = { ...styleBase, font: { ...styleBase.font, bold: true }, alignment: { horizontal: "right", vertical: "center", indent: 1 }, numFmt: "#,##0.##" };
                    }
                    // E: Prix unit
                    if (ws[`E${i+1}`]) {
                      if (r.hasPrice) {
                        ws[`E${i+1}`].s = { ...styleBase, alignment: { horizontal: "right", vertical: "center", indent: 1 }, numFmt: "#,##0.00" };
                      } else {
                        ws[`E${i+1}`].s = { ...styleBase, font: { ...styleBase.font, italic: true, color: { rgb: MUTED } }, alignment: { horizontal: "right", vertical: "center", indent: 1 } };
                      }
                    }
                    // F: Valeur
                    if (ws[`F${i+1}`]) {
                      if (r.hasPrice) {
                        ws[`F${i+1}`].s = { ...styleBase, font: { ...styleBase.font, bold: true }, alignment: { horizontal: "right", vertical: "center", indent: 1 }, numFmt: "#,##0.00" };
                      } else {
                        ws[`F${i+1}`].s = { ...styleBase, font: { ...styleBase.font, italic: true, color: { rgb: MUTED } }, alignment: { horizontal: "right", vertical: "center", indent: 1 } };
                      }
                    }
                  }

                  // Total row
                  const tr = totalRowIdx + 1;
                  ["A","B","C","D"].forEach(col => {
                    const cell = ws[`${col}${tr}`];
                    if (cell) {
                      cell.s = {
                        fill: { fgColor: { rgb: CARAMEL } },
                        border: { top: { style: "medium", color: { rgb: COFFEE_DARK } } }
                      };
                    } else {
                      // Cell may not exist if value is "" — create it
                      ws[`${col}${tr}`] = { v: "", t: "s", s: {
                        fill: { fgColor: { rgb: CARAMEL } },
                        border: { top: { style: "medium", color: { rgb: COFFEE_DARK } } }
                      }};
                    }
                  });
                  if (ws[`E${tr}`]) {
                    ws[`E${tr}`].s = {
                      font: { name: "Calibri", sz: 12, bold: true, color: { rgb: COFFEE_DARK } },
                      fill: { fgColor: { rgb: CARAMEL } },
                      alignment: { horizontal: "right", vertical: "center", indent: 1 },
                      border: { top: { style: "medium", color: { rgb: COFFEE_DARK } } }
                    };
                  }
                  if (ws[`F${tr}`]) {
                    ws[`F${tr}`].s = {
                      font: { name: "Calibri", sz: 13, bold: true, color: { rgb: COFFEE_DARK } },
                      fill: { fgColor: { rgb: CARAMEL } },
                      alignment: { horizontal: "right", vertical: "center", indent: 1 },
                      border: { top: { style: "medium", color: { rgb: COFFEE_DARK } } },
                      numFmt: "#,##0.00"
                    };
                  }

                  // === Build & download ===
                  const wb = XLSXStyle.utils.book_new();
                  XLSXStyle.utils.book_append_sheet(wb, ws, "Stock");
                  XLSXStyle.writeFile(wb, `stock-${farmName.replace(/ /g,"-")}-${fileDate}.xlsx`);
                }}>📊 Export Excel</button>
              </div>
              {/* Modal historique produit */}
              {selectedProduct && (() => {
                const productMvs = farmMovements.filter(m => m.product === selectedProduct).sort((a,b) => b.date.localeCompare(a.date));
                const stockItem = farmStock.find(s => s.product === selectedProduct);
                return (
                  <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={() => setSelectedProduct(null)}>
                    <div style={{background:"#fff",borderRadius:20,width:"100%",maxWidth:600,maxHeight:"80vh",overflow:"hidden",display:"flex",flexDirection:"column",boxShadow:"0 20px 60px rgba(0,0,0,0.2)"}} onClick={e => e.stopPropagation()}>
                      <div style={{padding:"20px 24px",borderBottom:"1px solid rgba(0,0,0,0.08)",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                        <div>
                          <div style={{fontSize:16,fontWeight:700,color:"#1d1d1f"}}>{selectedProduct}</div>
                          <div style={{fontSize:12,color:"#86868b",marginTop:2}}>
                            Stock actuel : <span style={{color:"#16a34a",fontWeight:700}}>{stockItem ? (stockItem.qty % 1 === 0 ? stockItem.qty : stockItem.qty.toFixed(2)) : 0} {stockItem?.unit||"KG"}</span>
                            {" · "}{productMvs.length} mouvement{productMvs.length>1?"s":""}
                          </div>
                        </div>
                        <button onClick={() => setSelectedProduct(null)} style={{background:"#f5f5f7",border:"none",borderRadius:10,width:32,height:32,cursor:"pointer",fontSize:16,color:"#6e6e73"}}>✕</button>
                      </div>
                      <div style={{overflowY:"auto",flex:1}}>
                        {productMvs.length === 0 ? (
                          <div style={{textAlign:"center",padding:40,color:"#86868b"}}>Aucun mouvement</div>
                        ) : productMvs.map((mv,i) => {
                          const isEntry = mv.type === "exit";
                          const resolvedType = isEntry ? "entry" : mv.type;
                          const t = isEntry ? {label:"Entrée magasin",color:"var(--theme-primary)",icon:"◍"} : (TYPE_LABELS[mv.type]||{label:mv.type,color:"#94a3b8",icon:"◷"});
                          const isPlus = resolvedType === "entry" || resolvedType === "transfer-in";
                          return (
                            <div key={mv.id||i} style={{display:"flex",alignItems:"center",padding:"12px 24px",borderBottom:"1px solid rgba(0,0,0,0.05)",gap:12}}>
                              <div style={{fontSize:11,color:"#86868b",width:80,fontFamily:"monospace",flexShrink:0}}>{mv.date}</div>
                              <span style={{background:t.color+"18",color:t.color,fontSize:11,fontWeight:600,padding:"3px 10px",borderRadius:20,flexShrink:0}}>{t.icon} {t.label}</span>
                              <div style={{flex:1,fontSize:12,color:"#6e6e73"}}>{mv.culture?(mv.culture+(mv.destination?" · "+mv.destination:"")):mv.toFarm?"→ "+mv.toFarm.replace("AGRO BERRY ","AB"):""}</div>
                              <div style={{fontWeight:700,fontSize:14,color:isPlus?"#16a34a":"#dc2626",fontFamily:"monospace",flexShrink:0}}>
                                {isPlus?"+":"-"}{mv.quantity%1===0?mv.quantity:parseFloat(mv.quantity).toFixed(2)} {mv.unit}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })()}

              {loadingStock ? (
                <div className="empty-state"><div className="empty-icon loading-spin">◈</div><div className="empty-text">Chargement...</div></div>
              ) : (
                <div className="stock-table">
                  <div className="stock-table-header"><span>Produit</span><span>Unité</span><span style={{textAlign:"right"}}>Quantité</span></div>

                  {positiveStock.map(s => {
                    const isLow = s.qty <= 10;
                    return (
                      <div key={s.product} className="stock-row" onClick={() => setSelectedProduct(s.product)}
                        style={{cursor:"pointer", background: isLow ? "rgba(251,191,36,0.06)" : ""}}>
                        <span className="stock-product" style={{display:"flex",alignItems:"center",gap:8}}>
                          {isLow && <span style={{fontSize:12}}>⚠️</span>}
                          {s.product}
                        </span>
                        <span className="stock-unit">{cleanUnit(s.unit)}</span>
                        <span className="stock-qty" style={{color: isLow ? "#d97706" : "#16a34a", textAlign:"right", fontFamily:"'Space Mono',monospace", fontSize:14, fontWeight:700}}>
                          {s.qty % 1 === 0 ? s.qty : s.qty.toFixed(2)}
                        </span>
                      </div>
                    );
                  })}

                </div>
              )}
            </div>
          )}

          {active === "report" && (() => {
            const period = MONTH_PERIODS[reportMonth];
            const priceMap = {};
            for (const m of allMovements) {
              if (m.type !== "entry") continue;
              const prix = parseFloat(m.price);
              const qty = parseFloat(m.quantity);
              if (!prix || !qty || prix <= 0 || qty <= 0) continue;
              const key = (m.product || "").toUpperCase();
              if (!priceMap[key]) priceMap[key] = { totalValue: 0, totalQty: 0 };
              priceMap[key].totalValue += prix * qty;
              priceMap[key].totalQty += qty;
            }
            const getPrice = (productName) => {
              const p = priceMap[(productName || "").toUpperCase()];
              if (p && p.totalQty > 0) return p.totalValue / p.totalQty;
              const productInfo = products.find(pp => pp.name?.toUpperCase() === productName?.toUpperCase());
              return parseFloat(productInfo?.price) || 0;
            };
            const rows = getFarmConsumptionReport(allMovements, farmName, physicalInventories, period.start, period.end)
              .filter(r => !stockSearch || r.product.toLowerCase().includes(stockSearch.toLowerCase()));
            const totals = rows.reduce((t, r) => {
              const prix = getPrice(r.product);
              t.init += r.init * prix; t.ent += r.ent * prix; t.sort += r.sort * prix;
              t.cons += r.cons * prix; t.final += r.final * prix;
              return t;
            }, { init:0, ent:0, sort:0, cons:0, final:0 });
            const fmt = (n) => Math.round(n).toLocaleString("fr-FR") + " MAD";
            const fmtQty = (n) => (n % 1 === 0 ? n : n.toFixed(2));
            return (
              <div className="page">
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12,marginBottom:16}}>
                  <div>
                    <h2 style={{fontSize:20,fontWeight:700,margin:0,color:"#1d1d1f"}}>📊 Rapport Mensuel — {farmShort}</h2>
                    <p style={{fontSize:12,color:"#86868b",margin:"4px 0 0"}}>
                      Période : <strong>{period.start.split("-").reverse().join("/")}</strong> → <strong>{period.end.split("-").reverse().join("/")}</strong>
                      {" · "}Stock Initial + Entrées − Sorties − Conso = Stock Final
                    </p>
                  </div>
                  <select className="form-input" style={{maxWidth:220}} value={reportMonth} onChange={e => setReportMonth(e.target.value)}>
                    {Object.entries(MONTH_PERIODS).map(([id, p]) => <option key={id} value={id}>{p.label}</option>)}
                  </select>
                </div>
                <div className="stats-grid" style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginBottom:16}}>
                  <div className="stat-card"><div className="stat-label">📦 Stock Initial</div><div className="stat-value">{fmt(totals.init)}</div></div>
                  <div className="stat-card"><div className="stat-label">📥 Entrées</div><div className="stat-value green">{fmt(totals.ent)}</div></div>
                  <div className="stat-card"><div className="stat-label">📤 Sorties</div><div className="stat-value">{fmt(totals.sort)}</div></div>
                  <div className="stat-card"><div className="stat-label">🔥 Consommation</div><div className="stat-value red">{fmt(totals.cons)}</div></div>
                  <div className="stat-card"><div className="stat-label">📊 Stock Final</div><div className="stat-value">{fmt(totals.final)}</div></div>
                </div>
                <input className="stock-search" style={{marginBottom:12,width:"100%",boxSizing:"border-box"}} placeholder="Rechercher un produit..." value={stockSearch} onChange={e => setStockSearch(e.target.value)} />
                {loadingStock ? (
                  <div className="empty-state"><div className="empty-icon loading-spin">◈</div><div className="empty-text">Chargement...</div></div>
                ) : rows.length === 0 ? (
                  <div className="empty-state"><div className="empty-icon">📊</div><div className="empty-text">Aucun mouvement sur cette période</div></div>
                ) : (
                  <div style={{overflowX:"auto",background:"#fff",border:"1px solid rgba(0,0,0,0.08)",borderRadius:16}}>
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                      <thead>
                        <tr style={{background:"#f5f5f7",borderBottom:"1px solid rgba(0,0,0,0.08)"}}>
                          {["Article","Unité","Stock Initial","Entrées","Sorties","Consommation","Stock Final"].map((h,i) => (
                            <th key={h} style={{padding:"10px 14px",textAlign:i===0?"left":"right",fontSize:10,fontWeight:700,color:"#6e6e73",textTransform:"uppercase",letterSpacing:"0.05em",whiteSpace:"nowrap"}}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(r => (
                          <tr key={r.product} style={{borderBottom:"1px solid rgba(0,0,0,0.05)"}}>
                            <td style={{padding:"10px 14px",fontWeight:600,color:"#1d1d1f"}}>{r.product}</td>
                            <td style={{padding:"10px 14px",textAlign:"right",color:"#86868b"}}>{cleanUnit(r.unit)}</td>
                            <td style={{padding:"10px 14px",textAlign:"right",fontFamily:"'Space Mono',monospace"}}>{fmtQty(r.init)}</td>
                            <td style={{padding:"10px 14px",textAlign:"right",fontFamily:"'Space Mono',monospace",color:r.ent>0?"#16a34a":"#c7c7cc"}}>{r.ent>0?"+":""}{fmtQty(r.ent)}</td>
                            <td style={{padding:"10px 14px",textAlign:"right",fontFamily:"'Space Mono',monospace",color:r.sort>0?"#dc2626":"#c7c7cc"}}>{r.sort>0?"-":""}{fmtQty(r.sort)}</td>
                            <td style={{padding:"10px 14px",textAlign:"right",fontFamily:"'Space Mono',monospace",color:r.cons>0?"#dc2626":"#c7c7cc"}}>{r.cons>0?"-":""}{fmtQty(r.cons)}</td>
                            <td style={{padding:"10px 14px",textAlign:"right",fontFamily:"'Space Mono',monospace",fontWeight:700}}>{fmtQty(r.final)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })()}

          {active === "globalstock" && (() => {
            const priceMap = {};
            for (const m of allMovements) {
              if (m.type !== "entry") continue;
              const prix = parseFloat(m.price);
              const qty = parseFloat(m.quantity);
              if (!prix || !qty || prix <= 0 || qty <= 0) continue;
              const key = (m.product || "").toUpperCase();
              if (!priceMap[key]) priceMap[key] = { totalValue: 0, totalQty: 0 };
              priceMap[key].totalValue += prix * qty;
              priceMap[key].totalQty += qty;
            }
            const getPrice = (productName) => {
              const p = priceMap[(productName || "").toUpperCase()];
              if (p && p.totalQty > 0) return p.totalValue / p.totalQty;
              const productInfo = products.find(pp => pp.name?.toUpperCase() === productName?.toUpperCase());
              return parseFloat(productInfo?.price) || 0;
            };

            const central = calcCentralStock(allMovements);
            const ab1 = calcFarmStock(allMovements, "AGRO BERRY 1", stockInitialAll.stockAB1 || [], physicalInventories);
            const ab2 = calcFarmStock(allMovements, "AGRO BERRY 2", stockInitialAll.stockAB2 || [], physicalInventories);
            const ab3 = calcFarmStock(allMovements, "AGRO BERRY 3", stockInitialAll.stockAB3 || [], physicalInventories);
            const ab1Map = {}; ab1.forEach(s => ab1Map[s.product] = s.qty);
            const ab2Map = {}; ab2.forEach(s => ab2Map[s.product] = s.qty);
            const ab3Map = {}; ab3.forEach(s => ab3Map[s.product] = s.qty);

            const productCat = {};
            products.forEach(p => { productCat[p.name] = p.category || "AUTRES"; });

            const allNames = new Set([
              ...Object.keys(central), ...Object.keys(ab1Map), ...Object.keys(ab2Map), ...Object.keys(ab3Map)
            ]);
            let rows = [...allNames].map(name => {
              const mag = Math.max(0, central[name]?.qty || 0);
              const unit = central[name]?.unit || ab1.find(s=>s.product===name)?.unit || ab2.find(s=>s.product===name)?.unit || ab3.find(s=>s.product===name)?.unit || "KG";
              const a1 = ab1Map[name] || 0, a2 = ab2Map[name] || 0, a3 = ab3Map[name] || 0;
              return { product: name, unit, category: productCat[name] || "AUTRES", mag, ab1: a1, ab2: a2, ab3: a3, total: mag+a1+a2+a3, price: getPrice(name) };
            }).filter(r => r.total > 0.001);
            if (globalStockSearch) rows = rows.filter(r => r.product.toLowerCase().includes(globalStockSearch.toLowerCase()));
            rows.sort((a,b) => a.product.localeCompare(b.product));

            const totals = rows.reduce((t,r) => {
              t.mag += r.mag*r.price; t.ab1 += r.ab1*r.price; t.ab2 += r.ab2*r.price; t.ab3 += r.ab3*r.price; t.total += r.total*r.price;
              return t;
            }, { mag:0, ab1:0, ab2:0, ab3:0, total:0 });
            const fmt = (n) => Math.round(n).toLocaleString("fr-FR") + " MAD";
            const fmtQty = (n) => (n % 1 === 0 ? n : n.toFixed(2));

            const handleExportGlobal = () => {
              const dateStr = new Date().toLocaleDateString("fr-FR", { weekday:"long", day:"2-digit", month:"long", year:"numeric" });
              const fileDate = new Date().toISOString().split("T")[0];
              const COFFEE_DARK="3E2C1F", COFFEE="6B4F35", CREAM="FFF8E7", WHITE="FFFFFF", BORDER="E8DFCE";
              const aoa = [];
              aoa.push(["🫐 Agro Berry", "", "", "", "", "", "", ""]);
              aoa.push(["Stock Global — Magasin + AB1 + AB2 + AB3", "", "", "", "", "", "", ""]);
              aoa.push([`📅 ${dateStr}`, "", "", "", "", "", "", ""]);
              aoa.push([`📦 ${rows.length} produits   💰 ${Math.round(totals.total).toLocaleString("fr-FR")} MAD`, "", "", "", "", "", "", ""]);
              aoa.push(["", "", "", "", "", "", "", ""]);
              aoa.push(["Produit","Catégorie","Unité","Prix (MAD)","MAG","AB1","AB2","AB3","TOTAL"]);
              rows.forEach(r => {
                aoa.push([r.product, r.category, r.unit, Math.round(r.price*100)/100, r.mag, r.ab1, r.ab2, r.ab3, r.total]);
              });
              const totRowIdx = aoa.length;
              aoa.push(["", "", "", "TOTAL (MAD)", Math.round(totals.mag), Math.round(totals.ab1), Math.round(totals.ab2), Math.round(totals.ab3), Math.round(totals.total)]);
              const ws = XLSXStyle.utils.aoa_to_sheet(aoa);
              ws["!cols"] = [{wch:30},{wch:16},{wch:8},{wch:12},{wch:11},{wch:11},{wch:11},{wch:11},{wch:12}];
              ws["!merges"] = [
                {s:{r:0,c:0},e:{r:0,c:8}}, {s:{r:1,c:0},e:{r:1,c:8}}, {s:{r:2,c:0},e:{r:2,c:8}}, {s:{r:3,c:0},e:{r:3,c:8}}, {s:{r:4,c:0},e:{r:4,c:8}}
              ];
              const border = { top:{style:"thin",color:{rgb:BORDER}}, bottom:{style:"thin",color:{rgb:BORDER}}, left:{style:"thin",color:{rgb:BORDER}}, right:{style:"thin",color:{rgb:BORDER}} };
              for (let c = 0; c < 9; c++) {
                const cell = ws[XLSXStyle.utils.encode_cell({r:5,c})];
                if (cell) cell.s = { font:{bold:true,color:{rgb:WHITE},sz:10}, fill:{fgColor:{rgb:COFFEE}}, alignment:{horizontal:c===0?"left":"center",vertical:"center"}, border };
              }
              for (let r = 6; r < totRowIdx; r++) {
                for (let c = 0; c < 9; c++) {
                  const cell = ws[XLSXStyle.utils.encode_cell({r,c})];
                  if (cell) cell.s = { font:{sz:9}, fill:{fgColor:{rgb:r%2===0?WHITE:CREAM}}, alignment:{horizontal:c===0?"left":"right",vertical:"center"}, border, numFmt: c>=4?"#,##0.##":undefined };
                }
              }
              for (let c = 0; c < 9; c++) {
                const cell = ws[XLSXStyle.utils.encode_cell({r:totRowIdx,c})];
                if (cell) cell.s = { font:{bold:true,sz:10,color:{rgb:WHITE}}, fill:{fgColor:{rgb:COFFEE_DARK}}, alignment:{horizontal:c===0?"left":"right",vertical:"center"}, border, numFmt: c>=4?"#,##0":undefined };
              }
              const wb = XLSXStyle.utils.book_new();
              XLSXStyle.utils.book_append_sheet(wb, ws, "Stock Global");
              XLSXStyle.writeFile(wb, `stock-global-${fileDate}.xlsx`);
            };

            return (
              <div className="page">
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12,marginBottom:16}}>
                  <div>
                    <h2 style={{fontSize:20,fontWeight:700,margin:0,color:"#1d1d1f"}}>🌍 Stock Global</h2>
                    <p style={{fontSize:12,color:"#86868b",margin:"4px 0 0"}}>Magasin central + AGB1 + AGB2 + AGB3 — instantané, en temps réel</p>
                  </div>
                  <button className="refresh-btn" style={{background:"#16a34a",border:"none",color:"#fff",fontWeight:600}} onClick={handleExportGlobal}>📊 Export Excel</button>
                </div>
                <div className="stats-grid" style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginBottom:16}}>
                  <div className="stat-card"><div className="stat-label">🏬 Magasin</div><div className="stat-value">{fmt(totals.mag)}</div></div>
                  <div className="stat-card"><div className="stat-label">🌿 AGB1</div><div className="stat-value">{fmt(totals.ab1)}</div></div>
                  <div className="stat-card"><div className="stat-label">🫐 AGB2</div><div className="stat-value">{fmt(totals.ab2)}</div></div>
                  <div className="stat-card"><div className="stat-label">🫐 AGB3</div><div className="stat-value">{fmt(totals.ab3)}</div></div>
                  <div className="stat-card"><div className="stat-label">📊 TOTAL</div><div className="stat-value">{fmt(totals.total)}</div></div>
                </div>
                <input className="stock-search" style={{marginBottom:12,width:"100%",boxSizing:"border-box"}} placeholder="Rechercher un produit..." value={globalStockSearch} onChange={e => setGlobalStockSearch(e.target.value)} />
                {loadingStock ? (
                  <div className="empty-state"><div className="empty-icon loading-spin">◈</div><div className="empty-text">Chargement...</div></div>
                ) : rows.length === 0 ? (
                  <div className="empty-state"><div className="empty-icon">🌍</div><div className="empty-text">Aucun produit en stock</div></div>
                ) : (
                  <div style={{overflowX:"auto",background:"#fff",border:"1px solid rgba(0,0,0,0.08)",borderRadius:16}}>
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                      <thead>
                        <tr style={{background:"#f5f5f7",borderBottom:"1px solid rgba(0,0,0,0.08)"}}>
                          {["Article","Unité","Magasin","AB1","AB2","AB3","Total"].map((h,i) => (
                            <th key={h} style={{padding:"10px 14px",textAlign:i===0?"left":"right",fontSize:10,fontWeight:700,color:"#6e6e73",textTransform:"uppercase",letterSpacing:"0.05em",whiteSpace:"nowrap"}}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(r => (
                          <tr key={r.product} style={{borderBottom:"1px solid rgba(0,0,0,0.05)"}}>
                            <td style={{padding:"10px 14px",fontWeight:600,color:"#1d1d1f"}}>{r.product}</td>
                            <td style={{padding:"10px 14px",textAlign:"right",color:"#86868b"}}>{cleanUnit(r.unit)}</td>
                            <td style={{padding:"10px 14px",textAlign:"right",fontFamily:"'Space Mono',monospace"}}>{fmtQty(r.mag)}</td>
                            <td style={{padding:"10px 14px",textAlign:"right",fontFamily:"'Space Mono',monospace"}}>{fmtQty(r.ab1)}</td>
                            <td style={{padding:"10px 14px",textAlign:"right",fontFamily:"'Space Mono',monospace"}}>{fmtQty(r.ab2)}</td>
                            <td style={{padding:"10px 14px",textAlign:"right",fontFamily:"'Space Mono',monospace"}}>{fmtQty(r.ab3)}</td>
                            <td style={{padding:"10px 14px",textAlign:"right",fontFamily:"'Space Mono',monospace",fontWeight:700}}>{fmtQty(r.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })()}

          {/* FORMS */}
          {active !== "history" && active !== "stock" && active !== "alerts" && active !== "melanges" && active !== "report" && active !== "globalstock" && (
            <div className="page">
              <div className="form-card">
                {success && <div className="alert success">✓ Enregistré avec succès !{active === "exit" && form.toFarm ? " · Entrée créée automatiquement sur "+form.toFarm.replace("AGRO BERRY ","AGB")+"." : ""}</div>}
                {error && <div className="alert error">✗ {error}</div>}
                <form onSubmit={handleSubmit}>
                  <div className="form-grid">
                    <div className="form-group full">
                      <div className="form-label">Type de mouvement</div>
                      <div className="type-grid">
                        {MENUS.filter(m => m.id !== "stock" && m.id !== "history" && m.id !== "alerts" && m.id !== "melanges").map(m => (
                          <button key={m.id} type="button" className={`type-btn ${active === m.id ? "active" : ""}`}
                            style={{ color: active === m.id ? m.color : "" }} onClick={() => setActive(m.id)}>
                            <span>{m.icon}</span>{m.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="form-group full">
                      <div className="form-label">Date *</div>
                      <input type="date" className="form-input" value={form.date} onChange={e => fset("date", e.target.value)} required max={new Date().toISOString().split("T")[0]} />
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
                                  <span className="product-meta">{cleanUnit(p.unit)}</span>
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
                      {(() => {
                        if (!form.product) return null;
                        const stockItem = farmStock.find(s => s.product === form.product);
                        const stockQty = stockItem ? Math.max(0, stockItem.qty) : 0;
                        const unit = stockItem ? stockItem.unit : form.unit;
                        const qty = parseFloat(form.quantity) || 0;
                        const remaining = stockQty - qty;
                        const isOver = qty > 0 && qty > stockQty + 0.001;
                        return (
                          <div style={{ marginTop:6, fontSize:12, fontWeight:600, display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                            <span style={{ color:"#86868b" }}>Stock dispo :</span>
                            <span style={{ color: stockQty > 0 ? "#16a34a" : "#dc2626" }}>
                              {stockQty % 1 === 0 ? stockQty : stockQty.toFixed(2)} {unit}
                            </span>
                            {qty > 0 && <>
                              <span style={{ color:"#86868b" }}>→ Reste :</span>
                              <span style={{ color: isOver ? "#dc2626" : "#16a34a", fontWeight:700 }}>
                                {remaining % 1 === 0 ? remaining : remaining.toFixed(2)} {unit}
                              </span>
                              {isOver && <span style={{ color:"#dc2626" }}>⚠ Stock insuffisant</span>}
                            </>}
                          </div>
                        );
                      })()}
                    </div>
                    <div className="form-group">
                      <div className="form-label">Unité</div>
                      {form.product ? (
                        <div className="form-input" style={{background:"#f5f5f7",color:"#6e6e73",cursor:"not-allowed",display:"flex",alignItems:"center"}}>{cleanUnit(form.unit)}</div>
                      ) : (
                        <select className="form-input" value={form.unit} onChange={e => fset("unit", e.target.value)}>
                          <option value="KG">KG</option><option value="L">L</option><option value="UNITÉ">UNITÉ</option>
                        </select>
                      )}
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
                    {active === "transfer" && (
                      <div className="form-group full">
                        <div className="form-label">Vers la ferme *</div>
                        <select className="form-input" 
                          value={FARMS.filter(f=>f!==farmName).includes(form.toFarm) ? form.toFarm : form.toFarm === "" ? "" : "__autre__"}
                          onChange={e => { 
                            if (e.target.value === "__autre__") fset("toFarm", "");
                            else fset("toFarm", e.target.value); 
                          }}>
                          <option value="">Sélectionner</option>
                          {FARMS.filter(f => f !== farmName).map(f => <option key={f} value={f}>{f}</option>)}
                          <option value="__autre__">✏️ Autre ferme...</option>
                        </select>
                        {!FARMS.filter(f=>f!==farmName).includes(form.toFarm) && form.toFarm !== "" && (
                          <input className="form-input" style={{marginTop:8}} value={form.toFarm}
                            onChange={e => fset("toFarm", e.target.value)}
                            placeholder="Ex: AGRO BERRY 4..." />
                        )}
                        {FARMS.filter(f=>f!==farmName).includes(form.toFarm) === false && form.toFarm === "" && (
                          <input className="form-input" style={{marginTop:8}} value=""
                            onChange={e => fset("toFarm", e.target.value)}
                            placeholder="Nom de la ferme..." />
                        )}
                      </div>
                    )}
                    <div className="form-group full">
                      <div className="form-label">Notes (optionnel)</div>
                      <textarea className="form-input" value={form.notes} onChange={e => fset("notes", e.target.value)} placeholder="Informations supplémentaires..." rows={2} style={{ resize:"vertical" }} />
                    </div>
                  </div>
                  <button type="submit" disabled={loading} className="submit-btn"
                    style={{ background: "linear-gradient(135deg, "+(activeMenu?.color||"#34C759")+"22, "+(activeMenu?.color||"#34C759")+"44)", color: activeMenu?.color, border: "1px solid "+(activeMenu?.color||"#34C759")+"44" }}>
                    {loading ? <><span className="loading-spin">◈</span> Enregistrement...</> : <><span>{activeMenu?.icon}</span> Enregistrer dans le stock</>}
                  </button>
                </form>
              </div>
            </div>
          )}

          {/* MOUVEMENTS - équivalent app admin */}
          {active === "history" && (
            <div className="page">
              {/* Stats */}
              {(() => {
                const entries = farmMovements.filter(m => m.type === "exit");
                const consos = farmMovements.filter(m => m.type === "consumption");
                const transfers = farmMovements.filter(m => m.type === "transfer-out" || m.type === "transfer-in");
                return (
                  <div className="stock-stats" style={{gridTemplateColumns:"repeat(4,1fr)",marginBottom:24}}>
                    <div className="stat-card" style={{background:"linear-gradient(135deg,var(--theme-bg),var(--theme-bg-med))",border:"1px solid rgba(var(--theme-rgb-l),0.2)"}}>
                      <div className="stat-label">Entrées magasin</div>
                      <div className="stat-value" style={{fontSize:22,color:"var(--theme-primary)"}}>{entries.length}</div>
                      <div style={{fontSize:11,color:"#86868b",marginTop:4}}>opérations</div>
                    </div>
                    <div className="stat-card" style={{background:"linear-gradient(135deg,#fff5f5,#fee2e2)",border:"1px solid rgba(220,38,38,0.2)"}}>
                      <div className="stat-label">Consommations</div>
                      <div className="stat-value" style={{fontSize:22,color:"#dc2626"}}>{consos.length}</div>
                      <div style={{fontSize:11,color:"#86868b",marginTop:4}}>opérations</div>
                    </div>
                    <div className="stat-card" style={{background:"linear-gradient(135deg,#f5f3ff,#ede9fe)",border:"1px solid rgba(139,92,246,0.2)"}}>
                      <div className="stat-label">Transferts</div>
                      <div className="stat-value" style={{fontSize:22,color:"#7c3aed"}}>{transfers.length}</div>
                      <div style={{fontSize:11,color:"#86868b",marginTop:4}}>opérations</div>
                    </div>
                    <div className="stat-card" style={{background:"#fff",border:"1px solid rgba(0,0,0,0.08)"}}>
                      <div className="stat-label">Total</div>
                      <div className="stat-value" style={{fontSize:22}}>{farmMovements.length}</div>
                      <div style={{fontSize:11,color:"#86868b",marginTop:4}}>mouvements</div>
                    </div>
                  </div>
                );
              })()}

              {/* Filters */}
              <div style={{background:"#fff",border:"1px solid rgba(0,0,0,0.08)",borderRadius:14,padding:16,marginBottom:20,boxShadow:"0 1px 6px rgba(0,0,0,0.04)"}}>
                <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:12,alignItems:"center"}}>
                  <input className="stock-search" style={{maxWidth:260,flex:1}} placeholder="🔍 Rechercher produit..." value={mvSearch} onChange={e => { setMvSearch(e.target.value); setMvPage(1); }} />
                  <input type="date" className="form-input" style={{width:140}} value={mvDateFrom} onChange={e => { setMvDateFrom(e.target.value); setMvPage(1); }} />
                  <input type="date" className="form-input" style={{width:140}} value={mvDateTo} onChange={e => { setMvDateTo(e.target.value); setMvPage(1); }} />
                  {(mvSearch || mvDateFrom || mvDateTo || mvFilter !== "all") && (
                    <button className="mv-filter-btn" onClick={() => { setMvSearch(""); setMvDateFrom(""); setMvDateTo(""); setMvFilter("all"); setMvPage(1); }}>🔄 Reset</button>
                  )}
                  <button className="refresh-btn" style={{marginLeft:"auto"}} onClick={loadData}>
                    <span className={loadingStock ? "loading-spin" : ""}>↻</span> Actualiser
                  </button>
                  <button className="refresh-btn" style={{background:"var(--theme-primary)",border:"none",color:"#fff",fontWeight:600}} onClick={() => {
                    const typeLabel = (mv) => {
                      if (mv.type==="exit") return "Entree magasin";
                      if (mv.type==="consumption") return "Consommation";
                      if (mv.type==="transfer-out") return "Transfert sortant";
                      if (mv.type==="transfer-in") return "Transfert entrant";
                      return mv.type;
                    };
                    const isPlus = (mv) => mv.type==="exit"||mv.type==="transfer-in";
                    const getDetail = (mv) => mv.culture?(mv.culture+(mv.destination?" - "+mv.destination:"")):mv.toFarm?mv.toFarm:mv.autoFrom?mv.autoFrom:"";
                    
                    // Ligne info ferme
                    const infoRow = [["Ferme", farmName], ["Date export", new Date().toLocaleDateString("fr-FR")], ["Total mouvements", filteredMv.length]];
                    
                    // Données principales
                    const headers = ["Date", "Produit", "Unite", "Type", "Quantite", "Detail", "Culture", "Destination"];
                    const rows = filteredMv.map(mv => [
                      mv.date || "",
                      mv.product || "",
                      mv.unit || "",
                      typeLabel(mv),
                      (isPlus(mv) ? 1 : -1) * (parseFloat(mv.quantity) || 0),
                      getDetail(mv),
                      mv.culture || "",
                      mv.destination || mv.toFarm || ""
                    ]);
                    
                    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
                    
                    // Largeurs colonnes
                    ws["!cols"] = [{wch:12},{wch:30},{wch:8},{wch:18},{wch:12},{wch:25},{wch:15},{wch:20}];
                    
                    const wb = XLSX.utils.book_new();
                    XLSX.utils.book_append_sheet(wb, ws, "Mouvements");
                    
                    // Feuille stats
                    const statsData = [
                      ["Statistiques", ""],
                      ["Ferme", farmName],
                      ["Date export", new Date().toLocaleDateString("fr-FR")],
                      ["", ""],
                      ["Type", "Nombre"],
                      ["Entrees magasin", filteredMv.filter(m=>m.type==="exit").length],
                      ["Consommations", filteredMv.filter(m=>m.type==="consumption").length],
                      ["Transferts", filteredMv.filter(m=>m.type==="transfer-out"||m.type==="transfer-in").length],
                      ["Total", filteredMv.length],
                    ];
                    const wsStats = XLSX.utils.aoa_to_sheet(statsData);
                    wsStats["!cols"] = [{wch:20},{wch:15}];
                    XLSX.utils.book_append_sheet(wb, wsStats, "Statistiques");
                    
                    XLSX.writeFile(wb, "mouvements-"+farmName.replace(/ /g,"-")+"-"+new Date().toISOString().split("T")[0]+".xlsx");
                  }}>📊 Excel</button>
                </div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
                  {[
                    { id:"all",          label:"📦 Tous" },
                    { id:"entry",        label:"◍ Entrées" },
                    { id:"consumption",  label:"🔥 Conso" },
                    { id:"transfer-out", label:"⇌ Transferts" },
                  ].map(f => (
                    <button key={f.id} className={`mv-filter-btn ${mvFilter === f.id ? "active" : ""}`}
                      onClick={() => { setMvFilter(f.id); setMvPage(1); }}>{f.label}
                    </button>
                  ))}
                  <span style={{marginLeft:"auto",fontSize:12,color:"#86868b"}}>{filteredMv.length} mouvement{filteredMv.length > 1 ? "s" : ""}</span>
                </div>
              </div>

              {/* Table */}
              {loadingStock ? (
                <div className="empty-state"><div className="empty-icon loading-spin">◈</div><div className="empty-text">Chargement...</div></div>
              ) : filteredMv.length === 0 ? (
                <div className="empty-state"><div className="empty-icon">◷</div><div className="empty-text">Aucun mouvement trouvé</div></div>
              ) : (
                <>
                  <div className="mv-table">
                    <div className="mv-table-header" style={{gridTemplateColumns:"110px 1fr 150px 100px 160px"}}>
                      <span>Date</span><span>Produit</span><span>Type</span><span style={{textAlign:"right"}}>Quantité</span><span style={{textAlign:"right"}}>Valeur</span><span>Détail</span>
                    </div>
                    {paginatedMv.map((mv, i) => {
                      if (!mv || !mv.product) return null;
                      const isEntryFromMagasin = mv.type === "exit";
                      const resolvedType = isEntryFromMagasin ? "entry" : mv.type;
                      const t = isEntryFromMagasin
                        ? { label: "Entrée magasin", color: "var(--theme-primary)", icon: "◍" }
                        : (TYPE_LABELS[mv.type] || { label: mv.type, color: "#94a3b8", icon: "◷" });
                      const isPlus = resolvedType === "entry" || resolvedType === "transfer-in";
                      let detail = "";
                      if (mv.culture) detail = mv.culture + (mv.destination ? " · " + mv.destination : "");
                      else if (mv.toFarm) detail = "→ " + mv.toFarm.replace("AGRO BERRY ","AB");
                      else if (mv.fromFarm) detail = "De " + mv.fromFarm.replace("AGRO BERRY ","AB");
                      else if (mv.autoFrom) detail = "← " + mv.autoFrom.replace("AGRO BERRY ","AB");
                      // Calcul valeur MAD - prix depuis le mouvement ou fiche produit
                      const productInfo = products.find(p => p.name?.toUpperCase() === mv.product?.toUpperCase());
                      const prix = parseFloat(mv.price) || parseFloat(productInfo?.price) || 0;
                      const valeur = prix * (parseFloat(mv.quantity) || 0);
                      return (
                        <div key={mv.id || i} className="mv-row" style={{gridTemplateColumns:"110px 1fr 150px 90px 90px 150px"}}>
                          <span className="mv-date">{mv.date}</span>
                          <div>
                            <div className="mv-product">{mv.product}</div>
                            <div style={{fontSize:11,color:"#86868b"}}>{mv.unit}</div>
                          </div>
                          <div>
                            <span className="mv-type" style={{background:t.color+"18",color:t.color}}>
                              {t.icon} {t.label}
                            </span>
                          </div>
                          <div className="mv-qty" style={{color:isPlus?"#16a34a":"#dc2626",textAlign:"right"}}>
                            {isPlus?"+":"-"}{(mv.quantity||0)%1===0?(mv.quantity||0):parseFloat(mv.quantity||0).toFixed(2)}
                          </div>
                          <div style={{textAlign:"right",fontSize:12,fontWeight:600,color:valeur>0?"#1d1d1f":"#86868b"}}>
                            {valeur>0 ? valeur.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:0})+" MAD" : "—"}
                          </div>
                          <div style={{fontSize:12,color:"#6e6e73"}}>{detail||"—"}</div>
                          <div style={{display:"flex",gap:4}}>
                            <button
                              onClick={() => { setEditingMv(mv); setEditDate(mv.date); }}
                              style={{background:"none",border:"none",cursor:"pointer",fontSize:15,padding:"2px 6px",color:"#06b6d4",opacity:0.7,transition:"opacity 0.2s"}}
                              title="Modifier la date"
                            >✏️</button>
                            <button
                              onClick={() => handleDelete(mv)}
                              disabled={deletingId === mv.id}
                              style={{background:"none",border:"none",cursor:"pointer",fontSize:15,padding:"2px 6px",color:"#dc2626",opacity:deletingId===mv.id?0.4:0.6,transition:"opacity 0.2s"}}
                              title="Supprimer"
                            >{deletingId === mv.id ? "⏳" : "🗑"}</button>
                          </div>

                          {/* Modal édition date */}
                          {editingMv?.id === mv.id && (
                            <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={() => setEditingMv(null)}>
                              <div style={{background:"#fff",borderRadius:16,padding:28,width:400,boxShadow:"0 20px 60px rgba(0,0,0,0.2)"}} onClick={e => e.stopPropagation()}>
                                <div style={{fontSize:16,fontWeight:700,color:"#1d1d1f",marginBottom:4}}>✏️ Modifier le mouvement</div>
                                <div style={{fontSize:13,color:"#86868b",marginBottom:20}}>{mv.type} — {mv.farm || farmName}</div>

                                <div style={{fontSize:11,fontWeight:700,color:"#6e6e73",textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>Produit</div>
                                <input className="form-input" style={{marginBottom:14}} value={editingMv.product}
                                  onChange={e => setEditingMv(prev => ({...prev, product: e.target.value.toUpperCase()}))} />

                                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
                                  <div>
                                    <div style={{fontSize:11,fontWeight:700,color:"#6e6e73",textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>Quantité</div>
                                    <input type="number" className="form-input" value={editingMv.quantity}
                                      onChange={e => setEditingMv(prev => ({...prev, quantity: e.target.value}))} min="0" step="0.01" />
                                  </div>
                                  <div>
                                    <div style={{fontSize:11,fontWeight:700,color:"#6e6e73",textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>Unité</div>
                                    <select className="form-input" value={editingMv.unit||"KG"} onChange={e => setEditingMv(prev => ({...prev, unit: e.target.value}))}>
                                      <option>KG</option><option>L</option><option>UNITÉ</option>
                                    </select>
                                  </div>
                                </div>

                                <div style={{fontSize:11,fontWeight:700,color:"#6e6e73",textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>Date</div>
                                <input type="date" className="form-input" value={editDate} onChange={e => setEditDate(e.target.value)} style={{marginBottom:20}} />

                                <div style={{display:"flex",gap:10}}>
                                  <button onClick={() => setEditingMv(null)} style={{flex:1,padding:"11px",background:"#f5f5f7",border:"none",borderRadius:10,fontSize:13,fontWeight:600,cursor:"pointer",color:"#6e6e73"}}>Annuler</button>
                                  <button onClick={handleEditDate} disabled={!!deletingId} style={{flex:1,padding:"11px",background:"#06b6d4",border:"none",borderRadius:10,fontSize:13,fontWeight:600,cursor:"pointer",color:"#fff"}}>
                                    {deletingId ? "⏳..." : "✅ Confirmer"}
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {mvTotalPages > 1 && (
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 20px",background:"#f5f5f7",border:"1px solid rgba(0,0,0,0.08)",borderTop:"none",borderRadius:"0 0 16px 16px",marginTop:-1}}>
                      <span style={{fontSize:13,color:"#86868b"}}>{(mvPage-1)*MV_PER_PAGE+1}–{Math.min(mvPage*MV_PER_PAGE,filteredMv.length)} sur {filteredMv.length}</span>
                      <div style={{display:"flex",gap:6}}>
                        <button className="mv-filter-btn" disabled={mvPage===1} onClick={()=>setMvPage(1)} style={{opacity:mvPage===1?0.4:1}}>«</button>
                        <button className="mv-filter-btn" disabled={mvPage===1} onClick={()=>setMvPage(p=>p-1)} style={{opacity:mvPage===1?0.4:1}}>‹</button>
                        <span style={{padding:"7px 14px",fontSize:12,fontWeight:600}}>{mvPage} / {mvTotalPages}</span>
                        <button className="mv-filter-btn" disabled={mvPage===mvTotalPages} onClick={()=>setMvPage(p=>p+1)} style={{opacity:mvPage===mvTotalPages?0.4:1}}>›</button>
                        <button className="mv-filter-btn" disabled={mvPage===mvTotalPages} onClick={()=>setMvPage(mvTotalPages)} style={{opacity:mvPage===mvTotalPages?0.4:1}}>»</button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {active === "melanges" && (
            <div className="page">
              <div style={{marginBottom:24,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
                <div>
                  <div style={{fontSize:22,fontWeight:700,color:"#1d1d1f",letterSpacing:"-0.5px"}}>⚗ Mélanges</div>
                  <div style={{fontSize:13,color:"#86868b",marginTop:4}}>Configure tes recettes — les seuils d'alerte se calculent automatiquement ×5</div>
                </div>
                <button
                  onClick={async () => {
                    setMelangesSaving(true);
                    try {
                      await saveMelangesConfig(farmName, melangesConfig);
                      setMelangesSaved(true);
                      setTimeout(() => setMelangesSaved(false), 3000);
                    } catch(e) { alert("Erreur sauvegarde : " + e.message); }
                    setMelangesSaving(false);
                  }}
                  style={{background: melangesSaved ? "var(--theme-primary)" : "#06b6d4", border:"none", color:"#fff", borderRadius:12, padding:"10px 20px", fontWeight:600, fontSize:14, cursor:"pointer", display:"flex", alignItems:"center", gap:8}}>
                  {melangesSaving ? "⏳ Enregistrement..." : melangesSaved ? "✅ Enregistré !" : "💾 Valider et Enregistrer"}
                </button>
              </div>

              {(farmName === "AGRO BERRY 3" ? ["horsSol"] : ["horsSol","sol"]).map(type => {
                const label = type === "horsSol" ? "💧 Hors Sol" : "🌱 Sol";
                const color = type === "horsSol" ? "#1e40af" : "#15803d";
                const bg = type === "horsSol" ? "linear-gradient(135deg,#eff6ff,#dbeafe)" : "linear-gradient(135deg,#f0fdf4,#dcfce7)";
                const border = type === "horsSol" ? "rgba(59,130,246,0.2)" : "rgba(34,197,94,0.2)";
                const items = melangesConfig[type] || [];

                // Mise à jour locale seulement (pas de GitHub sur chaque frappe)
                const updateItemLocal = (idx, field, val) => {
                  const updated = { ...melangesConfig, [type]: items.map((it, i) => i === idx ? { ...it, [field]: val } : it) };
                  setMelangesConfig(updated);
                  return updated;
                };
                // Sauvegarde GitHub (appel seulement quand nécessaire)
                const updateItemSave = (idx, field, val) => {
                  updateItemLocal(idx, field, val);
                };
                const addItem = () => {
                  const updated = { ...melangesConfig, [type]: [...items, { product: "", qty: "", unit: "KG" }] };
                  setMelangesConfig(updated);
                };
                const removeItem = (idx) => {
                  const updated = { ...melangesConfig, [type]: items.filter((_,i) => i !== idx) };
                  setMelangesConfig(updated);
                };

                return (
                  <div key={type} style={{marginBottom:24,background:"#fff",border:"1px solid "+border,borderRadius:16,overflow:"visible",boxShadow:"0 1px 6px rgba(0,0,0,0.04)"}}>
                    <div style={{padding:"14px 20px",background:bg,borderBottom:"1px solid "+border,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                      <div style={{fontWeight:700,color,fontSize:15}}>{label}</div>
                      <div style={{display:"flex",alignItems:"center",gap:10}}>
                        <span style={{fontSize:12,color:"#86868b"}}>{items.length} produit{items.length>1?"s":""} · Seuil total ×5 : <b style={{color}}>{items.reduce((s,it) => s + (parseFloat(it.qty)||0)*5, 0).toFixed(1)}</b></span>
                        <button onClick={addItem} style={{background:color,color:"#fff",border:"none",borderRadius:8,padding:"6px 14px",fontSize:12,fontWeight:600,cursor:"pointer"}}>+ Ajouter</button>
                      </div>
                    </div>
                    {items.length === 0 ? (
                      <div style={{padding:"30px 20px",textAlign:"center",color:"#86868b",fontSize:13}}>Aucun produit configuré — clique sur "+ Ajouter"</div>
                    ) : (
                      <>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 100px 80px 40px",padding:"8px 20px",background:"#f9fafb",fontSize:10,fontWeight:700,color:"#6e6e73",textTransform:"uppercase",letterSpacing:".08em"}}>
                          <span>Produit</span><span style={{textAlign:"right"}}>Qté / mélange</span><span style={{textAlign:"center"}}>Unité</span><span></span>
                        </div>
                        {items.map((item, idx) => (
                          <div key={idx} style={{display:"grid",gridTemplateColumns:"1fr 100px 80px 40px",padding:"10px 20px",borderBottom:"1px solid rgba(0,0,0,0.05)",alignItems:"center",gap:8}}>
                            <div style={{position:"relative"}}>
                              <input className="form-input" style={{fontSize:13}} value={item.product}
                                onChange={e => {
                                  const updated = { ...melangesConfig, [type]: items.map((it, i) => i === idx ? { ...it, product: e.target.value.toUpperCase(), _showDrop: true } : it) };
                                  setMelangesConfig(updated);
                                }}
                                placeholder="Nom du produit..." autoComplete="off" />
                              {item.product.length >= 2 && item._showDrop !== false && (
                                <div style={{position:"absolute",bottom: idx === items.length-1 ? "calc(100% + 4px)" : "auto", top: idx === items.length-1 ? "auto" : "calc(100% + 4px)",left:0,right:0,background:"#fff",border:"1px solid rgba(0,0,0,0.12)",borderRadius:12,maxHeight:200,overflowY:"auto",zIndex:9999,boxShadow:"0 8px 30px rgba(0,0,0,0.15)"}}>
                                  {products.length === 0 ? (
                                    <div style={{padding:"10px 14px",fontSize:12,color:"#86868b"}}>Chargement des produits...</div>
                                  ) : products.filter(p => p.name.toUpperCase().includes(item.product)).length === 0 ? (
                                    <div style={{padding:"10px 14px",fontSize:12,color:"#86868b"}}>Aucun produit trouvé</div>
                                  ) : products.filter(p => p.name.toUpperCase().includes(item.product)).slice(0,8).map(p => (
                                    <div key={p.id}
                                      onMouseDown={e => { e.preventDefault(); const updated = { ...melangesConfig, [type]: items.map((it, i) => i === idx ? { ...it, product: p.name.toUpperCase(), _showDrop: false } : it) }; setMelangesConfig(updated); saveMelangesConfig(farmName, updated).catch(console.error); }}
                                      style={{padding:"10px 14px",cursor:"pointer",display:"flex",justifyContent:"space-between",fontSize:13,borderBottom:"1px solid rgba(0,0,0,0.05)"}}
                                      onMouseEnter={e => e.currentTarget.style.background="var(--theme-bg)"}
                                      onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                                      <span style={{fontWeight:500,color:"#1d1d1f"}}>{p.name.toUpperCase()}</span>
                                      <span style={{fontSize:11,color:"#86868b"}}>{cleanUnit(p.unit)}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                            <input type="number" className="form-input" style={{textAlign:"right",fontSize:13}} value={item.qty}
                              onChange={e => updateItemLocal(idx, "qty", e.target.value)}
                              placeholder="0" min="0" step="0.01" />
                            <select className="form-input" style={{fontSize:13}} value={item.unit||"KG"}
                              onChange={e => updateItemSave(idx, "unit", e.target.value)}>
                              <option>KG</option><option>L</option><option>UNITÉ</option>
                            </select>
                            <button onClick={() => removeItem(idx)} style={{background:"none",border:"none",color:"#dc2626",cursor:"pointer",fontSize:18,padding:0}}>✕</button>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                );
              })}

              <div style={{background:"linear-gradient(135deg,var(--theme-bg),var(--theme-bg-med))",border:"1px solid rgba(var(--theme-rgb-l),0.2)",borderRadius:14,padding:"16px 20px"}}>
                <div style={{fontWeight:700,color:"var(--theme-primary)",fontSize:13,marginBottom:12}}>📊 Aperçu des seuils calculés ×5</div>
                {Object.entries(calcSeuils(melangesConfig)).length === 0 ? (
                  <div style={{color:"#86868b",fontSize:13}}>Configure tes mélanges ci-dessus pour voir les seuils</div>
                ) : (
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:8}}>
                    {Object.entries(calcSeuils(melangesConfig)).map(([name, s]) => (
                      <div key={name} style={{background:"#fff",borderRadius:10,padding:"10px 14px",border:"1px solid rgba(var(--theme-rgb-l),0.15)"}}>
                        <div style={{fontSize:12,fontWeight:600,color:"#1d1d1f",marginBottom:2}}>{name}</div>
                        <div style={{fontSize:16,fontWeight:800,color:"#16a34a",fontFamily:"monospace"}}>{s.qty % 1 === 0 ? s.qty : s.qty.toFixed(1)} {s.unit}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          {active === "alerts" && (
            <div className="page">
              <div style={{marginBottom:24,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
                <div>
                  <div style={{fontSize:22,fontWeight:700,color:"#1d1d1f",letterSpacing:"-0.5px"}}>⚠ Alertes Stock</div>
                  <div style={{fontSize:13,color:"#86868b",marginTop:4}}>Seuil = 5 mélanges · configuré dans Mélanges</div>
                </div>
                <div style={{display:"flex",gap:10}}>
                  <button className="refresh-btn" style={{background:"#dc2626",border:"none",color:"#fff",fontWeight:600}} onClick={() => {
                    const date = new Date().toLocaleDateString("fr-FR",{day:"2-digit",month:"long",year:"numeric"});
                    const seuils = calcSeuils(melangesConfig);
                    const critiques = Object.entries(seuils).filter(([name,s]) => {
                      const qty = (farmStock.find(x=>x.product.toUpperCase()===name.toUpperCase())?.qty)||0;
                      return qty < s.qty;
                    });
                    const makeRows = (items) => items.map(([name,seuil]) => {
                      const qty = (farmStock.find(x=>x.product.toUpperCase()===name.toUpperCase())?.qty)||0;
                      return "<tr><td>"+name+"</td><td style='text-align:center'>"+seuil.unit+"</td><td style='text-align:right;font-weight:700;color:#dc2626'>"+(qty%1===0?qty:qty.toFixed(2))+"</td><td style='text-align:right;color:#6e6e73'>"+seuil.qty+"</td></tr>";
                    }).join("");
                    const html = "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Alertes "+farmName+"</title><style>body{font-family:Arial,sans-serif;padding:30px;color:#1d1d1f}table{width:100%;border-collapse:collapse}th{padding:8px 12px;background:#f5f5f7;font-size:10px;text-transform:uppercase;color:#6e6e73;text-align:left;border-bottom:2px solid #e5e7eb}td{padding:8px 12px;font-size:12px;border-bottom:1px solid #f0f0f0}.footer{margin-top:20px;font-size:10px;color:#86868b;display:flex;justify-content:space-between;border-top:1px solid #e5e7eb;padding-top:12px}</style></head><body><h1 style='color:#f59e0b;font-size:20px;margin-bottom:4px'>Alertes Stock</h1><p style='color:#86868b;font-size:12px;margin-bottom:20px'>"+farmName+" - "+date+"</p>"+(critiques.length>0?"<h3 style='color:#dc2626;margin:16px 0 8px'>Produits a commander ("+critiques.length+")</h3><table><thead><tr><th>Produit</th><th>Unite</th><th style='text-align:right'>Stock actuel</th><th style='text-align:right'>Seuil x5</th></tr></thead><tbody>"+makeRows(critiques)+"</tbody></table>":"<p style='color:#16a34a;font-weight:700'>Tous les stocks sont suffisants !</p>")+"<div class='footer'><span>Agro Berry Magasinier</span><span>"+date+"</span></div><script>window.onload=function(){window.print()}<\/script></body></html>";
                    const w=window.open("","_blank"); w.document.write(html); w.document.close();
                  }}>📄 Export PDF</button>
                  <button className="refresh-btn" style={{background:"var(--theme-primary)",border:"none",color:"#fff",fontWeight:600}} onClick={() => {
                    const seuils = calcSeuils(melangesConfig);
                    const rows = Object.entries(seuils).map(([name,seuil]) => {
                      const qty = (farmStock.find(x=>x.product.toUpperCase()===name.toUpperCase())?.qty)||0;
                      const statut = qty < seuil.qty ? "CRITIQUE" : "OK";
                      return [name, seuil.unit, qty%1===0?qty:qty.toFixed(2), seuil.qty, statut];
                    }).filter(r => r[4] !== "OK");
                    exportExcel(["Produit","Unite","Stock actuel","Seuil x5","Statut"], rows, "alertes-"+farmName.replace(/ /g,"-"));
                  }}>📊 Export Excel</button>
                </div>
              </div>

              {(() => {
                const seuils = calcSeuils(melangesConfig);
                if (Object.keys(seuils).length === 0) return (
                  <div style={{textAlign:"center",padding:"60px 20px"}}>
                    <div style={{fontSize:48,marginBottom:12}}>⚗</div>
                    <div style={{fontSize:18,fontWeight:700,color:"#1d1d1f"}}>Aucun mélange configuré</div>
                    <div style={{fontSize:13,color:"#86868b",marginTop:8}}>Va dans <b>Mélanges</b> pour configurer tes recettes</div>
                    <button className="refresh-btn" style={{marginTop:16,background:"#06b6d4",border:"none",color:"#fff",fontWeight:600}} onClick={() => setActive("melanges")}>⚗ Configurer les mélanges</button>
                  </div>
                );
                const all = Object.entries(seuils).map(([name, seuil]) => {
                  const s = farmStock.find(x => x.product.toUpperCase() === name.toUpperCase());
                  const qty = s ? s.qty : 0;
                  const pct = seuil.qty > 0 ? Math.min(qty / seuil.qty * 100, 100) : 100;
                  const isCritique = qty < seuil.qty;
                  return { name, seuil, qty, pct, isCritique };
                });
                const critiques = all.filter(x => x.isCritique);

                if (critiques.length === 0) return (
                  <div style={{textAlign:"center",padding:"60px 20px"}}>
                    <div style={{fontSize:48,marginBottom:12}}>🟢</div>
                    <div style={{fontSize:18,fontWeight:700,color:"var(--theme-primary)"}}>Tous les stocks sont suffisants !</div>
                    <div style={{fontSize:13,color:"#86868b",marginTop:8}}>Stock suffisant pour 5 mélanges pour tous les produits</div>
                  </div>
                );

                return (
                  <div>
                    <div style={{display:"flex",alignItems:"center",gap:10,padding:"12px 20px",background:"linear-gradient(135deg,#fff5f5,#fee2e2)",borderRadius:"14px 14px 0 0",border:"1px solid rgba(220,38,38,0.2)",borderBottom:"none"}}>
                      <span style={{fontSize:20}}>🔴</span>
                      <div>
                        <div style={{fontWeight:700,color:"#dc2626",fontSize:14}}>Produits à commander — Stock insuffisant</div>
                        <div style={{fontSize:12,color:"#b91c1c",marginTop:2}}>Stock {"<"} 5 mélanges</div>
                      </div>
                      <span style={{marginLeft:"auto",background:"#dc2626",color:"#fff",borderRadius:20,padding:"3px 12px",fontWeight:700,fontSize:13}}>{critiques.length}</span>
                    </div>
                    <div style={{background:"#fff",border:"1px solid rgba(220,38,38,0.15)",borderTop:"none",borderRadius:"0 0 14px 14px",overflow:"hidden"}}>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 70px 120px 120px",padding:"10px 20px",background:"#fef2f2",fontSize:10,fontWeight:700,color:"#6e6e73",textTransform:"uppercase",letterSpacing:".08em"}}>
                        <span>Produit</span><span style={{textAlign:"center"}}>Unité</span><span style={{textAlign:"right"}}>Stock actuel</span><span style={{textAlign:"right"}}>Seuil (×5)</span>
                      </div>
                      {critiques.map(item => (
                        <div key={item.name} style={{display:"grid",gridTemplateColumns:"1fr 70px 120px 120px",padding:"14px 20px",borderBottom:"1px solid rgba(0,0,0,0.05)",alignItems:"center"}}>
                          <div>
                            <div style={{fontSize:13,fontWeight:600,color:"#1d1d1f"}}>{item.name}</div>
                            <div style={{height:5,background:"#f0f0f0",borderRadius:4,marginTop:5,overflow:"hidden"}}>
                              <div style={{height:"100%",width:item.pct+"%",background:"#dc2626",borderRadius:4}}/>
                            </div>
                          </div>
                          <div style={{textAlign:"center",fontSize:12,color:"#86868b"}}>{cleanUnit(item.seuil.unit)}</div>
                          <div style={{textAlign:"right",fontSize:18,fontWeight:800,color:"#dc2626",fontFamily:"monospace"}}>
                            {item.qty%1===0?item.qty:item.qty.toFixed(2)}
                          </div>
                          <div style={{textAlign:"right",fontSize:13,fontWeight:700,color:"#86868b",fontFamily:"monospace"}}>
                            {item.seuil.qty%1===0?item.seuil.qty:item.seuil.qty.toFixed(1)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
