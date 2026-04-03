import { useState, useEffect } from "react";
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
const MENUS = [
  { id:"stock",       label:"Mon Stock",      icon:"📦", color:"#185FA5" },
  { id:"consumption", label:"Consommation",   icon:"🔥", color:"#e24b4a" },
  { id:"exit",        label:"Sortie magasin", icon:"📤", color:"#BA7517" },
  { id:"entry",       label:"Entree",         icon:"📥", color:"#1d9e75" },
  { id:"transfer",    label:"Transfert",      icon:"🔄", color:"#534AB7" },
  { id:"history",     label:"Historique",     icon:"📋", color:"#555"    },
];
const INPUT = { width:"100%", padding:"9px 12px", border:"1px solid #ddd", borderRadius:7, fontSize:14, boxSizing:"border-box", outline:"none", background:"white" };
const LABEL = { fontSize:12, fontWeight:600, color:"#555", display:"block", marginBottom:5, textTransform:"uppercase", letterSpacing:"0.04em" };

async function fetchGitHubData() {
  const res = await fetch("https://api.github.com/repos/"+GITHUB_OWNER+"/"+GITHUB_REPO+"/contents/"+GITHUB_FILE, {
    headers: { Authorization: "Bearer "+GITHUB_TOKEN, Accept: "application/vnd.github+json" }
  });
  if (!res.ok) throw new Error("Erreur GitHub " + res.status);
  const f = await res.json();
  return { data: JSON.parse(atob(f.content.replace(/\n/g,""))), sha: f.sha };
}

async function saveToGitHub(movement) {
  const { data, sha } = await fetchGitHubData();
  data.movements.push({ ...movement, id: Date.now() });
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
  const put = await fetch("https://api.github.com/repos/"+GITHUB_OWNER+"/"+GITHUB_REPO+"/contents/"+GITHUB_FILE, {
    method: "PUT",
    headers: { Authorization: "Bearer "+GITHUB_TOKEN, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ message: "["+movement.farm+"] "+movement.type+": "+movement.product, content, sha })
  });
  if (!put.ok) throw new Error("Erreur ecriture GitHub " + put.status);
}

function calcFarmStock(movements, farmName) {
  const stock = {};
  for (const mv of movements) {
    const p = mv.product;
    if (!stock[p]) stock[p] = { product:p, unit:mv.unit||"KG", qty:0 };
    if (mv.type==="exit" && mv.farm===farmName) stock[p].qty += mv.quantity;
    if (mv.type==="transfer-in" && mv.farm===farmName) stock[p].qty += mv.quantity;
    if (mv.type==="consumption" && mv.farm===farmName) stock[p].qty -= mv.quantity;
    if (mv.type==="transfer-out" && mv.farm===farmName) stock[p].qty -= mv.quantity;
  }
  return Object.values(stock).filter(s => Math.abs(s.qty)>0).sort((a,b)=>a.product.localeCompare(b.product));
}

export default function Dashboard({ user, userInfo }) {
  const [active, setActive] = useState("stock");
  const [demandes, setDemandes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");
  const [products, setProducts] = useState([]);
  const [farmStock, setFarmStock] = useState([]);
  const [loadingStock, setLoadingStock] = useState(true);
  const [search, setSearch] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [customProduct, setCustomProduct] = useState(false);
  const [stockSearch, setStockSearch] = useState("");
  const farmName = userInfo?.farm || "AGRO BERRY 1";
  const farmConfig = FARM_CONFIG[farmName] || FARM_CONFIG["AGRO BERRY 1"];
  const emptyForm = { product:"", quantity:"", unit:"KG", culture:farmConfig.cultures[0], destination:"", supplier:"", price:"", toFarm:"", notes:"" };
  const [form, setForm] = useState(emptyForm);
  const fset = (k,v) => setForm(prev=>({...prev,[k]:v}));
  const destinations = farmConfig.destinations[form.culture] || [];

  useEffect(() => {
    fetchGitHubData().then(({data}) => {
      setProducts([...data.products].sort((a,b)=>a.name.localeCompare(b.name)));
      setFarmStock(calcFarmStock(data.movements, farmName));
    }).catch(()=>{}).finally(()=>setLoadingStock(false));
  }, [farmName]);

  useEffect(() => {
    const q = query(collection(db,"demandes"), where("farmId","==",user.uid), orderBy("createdAt","desc"));
    return onSnapshot(q, snap=>setDemandes(snap.docs.map(d=>({id:d.id,...d.data()}))));
  }, [user.uid]);

  const filtered = products.filter(p=>p.name.toLowerCase().includes(search.toLowerCase())).slice(0,30);
  const filteredStock = farmStock.filter(s=>s.product.toLowerCase().includes(stockSearch.toLowerCase()));

  const handleSelectProduct = (p) => { fset("product",p.name); fset("unit",p.unit||"KG"); setSearch(p.name); setShowDropdown(false); };

  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true); setError("");
    try {
      const today = new Date().toISOString().split("T")[0];
      const mv = { type:active==="transfer"?"transfer-out":active, product:form.product, quantity:parseFloat(form.quantity), unit:form.unit, farm:farmName, date:today };
      if(active==="consumption"){mv.culture=form.culture;mv.destination=form.destination;}
      if(active==="entry"){if(form.supplier)mv.supplier=form.supplier;if(form.price)mv.price=parseFloat(form.price);}
      if(active==="transfer")mv.toFarm=form.toFarm;
      if(form.notes)mv.notes=form.notes;
      mv.saisiepar=user.email;
      await saveToGitHub(mv);
      await addDoc(collection(db,"demandes"),{...mv,farmId:user.uid,farmName,status:"saved",createdAt:new Date().toISOString()});
      setSuccess(true); setForm(emptyForm); setSearch(""); setCustomProduct(false);
      setTimeout(()=>setSuccess(false),4000);
    } catch(err){setError(err.message);}
    setLoading(false);
  };

  const activeMenu = MENUS.find(m=>m.id===active);

  return (
    <div style={{display:"flex",minHeight:"100vh",fontFamily:"system-ui,sans-serif",background:"#f4f6f8"}}>
      <div style={{width:220,background:"#1a2332",display:"flex",flexDirection:"column",position:"fixed",top:0,left:0,height:"100vh",zIndex:100}}>
        <div style={{padding:"20px 16px 16px",borderBottom:"1px solid rgba(255,255,255,0.08)"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:28}}>🫐</span>
            <div>
              <div style={{color:"white",fontWeight:700,fontSize:14}}>Agro Berry</div>
              <div style={{color:"#1d9e75",fontSize:11,fontWeight:600}}>{farmName}</div>
            </div>
          </div>
        </div>
        <nav style={{flex:1,padding:"12px 8px"}}>
          {MENUS.map(m=>(
            <button key={m.id} onClick={()=>setActive(m.id)}
              style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:8,border:"none",background:active===m.id?"rgba(29,158,117,0.15)":"transparent",color:active===m.id?"#1d9e75":"#aab4c4",cursor:"pointer",fontSize:13,fontWeight:active===m.id?600:400,marginBottom:2,textAlign:"left"}}>
              <span style={{fontSize:16}}>{m.icon}</span>{m.label}
              {m.id==="history"&&demandes.length>0&&<span style={{marginLeft:"auto",background:"#1d9e75",color:"white",fontSize:10,padding:"1px 7px",borderRadius:10,fontWeight:700}}>{demandes.length}</span>}
              {m.id==="stock"&&farmStock.length>0&&<span style={{marginLeft:"auto",background:"#185FA5",color:"white",fontSize:10,padding:"1px 7px",borderRadius:10,fontWeight:700}}>{farmStock.length}</span>}
            </button>
          ))}
        </nav>
        <div style={{padding:"12px 16px",borderTop:"1px solid rgba(255,255,255,0.08)"}}>
          <div style={{color:"#aab4c4",fontSize:11,marginBottom:8}}>{user.email}</div>
          <button onClick={()=>signOut(auth)} style={{width:"100%",padding:"8px",background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:7,color:"#aab4c4",fontSize:12,cursor:"pointer"}}>Deconnexion</button>
        </div>
      </div>

      <div style={{marginLeft:220,flex:1,padding:"28px"}}>
        <div style={{marginBottom:24}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
            <span style={{fontSize:22}}>{activeMenu?.icon}</span>
            <h1 style={{margin:0,fontSize:20,fontWeight:700,color:"#1a2332"}}>{activeMenu?.label}</h1>
          </div>
          <p style={{margin:0,fontSize:13,color:"#888"}}>{active==="stock"?"Stock actuel de "+farmName:active!=="history"?"Saisie directe — "+farmName:"Historique — "+farmName}</p>
        </div>

        {active==="stock"&&(
          <div style={{maxWidth:720}}>
            <div style={{marginBottom:16,display:"flex",gap:12,alignItems:"center"}}>
              <input value={stockSearch} onChange={e=>setStockSearch(e.target.value)} placeholder="Rechercher dans le stock..." style={{...INPUT,maxWidth:360,background:"white"}}/>
              <button onClick={()=>{setLoadingStock(true);fetchGitHubData().then(({data})=>setFarmStock(calcFarmStock(data.movements,farmName))).finally(()=>setLoadingStock(false));}}
                style={{padding:"9px 16px",background:"white",border:"1px solid #1d9e75",borderRadius:7,color:"#1d9e75",fontSize:13,fontWeight:500,cursor:"pointer"}}>🔄 Actualiser</button>
            </div>
            {loadingStock?(
              <div style={{background:"white",borderRadius:12,padding:40,textAlign:"center",color:"#aaa"}}><div style={{fontSize:32,marginBottom:8}}>⏳</div><p>Chargement...</p></div>
            ):filteredStock.length===0?(
              <div style={{background:"white",borderRadius:12,padding:40,textAlign:"center",color:"#aaa"}}><div style={{fontSize:40,marginBottom:8}}>📦</div><p>Aucun produit en stock</p></div>
            ):(
              <div style={{background:"white",borderRadius:12,overflow:"hidden",boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
                <div style={{padding:"14px 20px",borderBottom:"1px solid #eee"}}>
                  <span style={{fontSize:13,color:"#888"}}>{filteredStock.length} produits</span>
                </div>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead>
                    <tr style={{background:"#f8f9fa"}}>
                      {["Produit","Unité","Stock actuel"].map(h=>(
                        <th key={h} style={{padding:"12px 20px",textAlign:"left",fontSize:11,fontWeight:600,color:"#888",textTransform:"uppercase",letterSpacing:"0.04em",borderBottom:"1px solid #eee"}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredStock.map((s,i)=>(
                      <tr key={s.product} style={{borderBottom:"1px solid #f0f0f0",background:i%2===0?"white":"#fafafa"}}>
                        <td style={{padding:"12px 20px",fontSize:13,fontWeight:500}}>{s.product}</td>
                        <td style={{padding:"12px 20px",fontSize:13,color:"#888"}}>{s.unit}</td>
                        <td style={{padding:"12px 20px"}}>
                          <span style={{fontSize:14,fontWeight:600,color:s.qty<0?"#e24b4a":s.qty===0?"#aaa":"#1a2332"}}>
                            {s.qty<0?"⚠️ ":""}{s.qty.toFixed(2)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {active!=="history"&&active!=="stock"&&(
          <div style={{background:"white",borderRadius:12,padding:24,boxShadow:"0 1px 4px rgba(0,0,0,0.06)",maxWidth:680}}>
            {success&&<div style={{background:"#EAF3DE",color:"#27500A",padding:"12px 16px",borderRadius:8,marginBottom:20,fontSize:14,fontWeight:500}}>✅ Enregistre dans le stock !</div>}
            {error&&<div style={{background:"#FCEBEB",color:"#791F1F",padding:"12px 16px",borderRadius:8,marginBottom:20,fontSize:13}}>❌ {error}</div>}
            <form onSubmit={handleSubmit}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
                <div style={{gridColumn:"1 / -1"}}>
                  <label style={LABEL}>Produit *</label>
                  {!customProduct?(
                    <div style={{position:"relative"}}>
                      <input value={search} onChange={e=>{setSearch(e.target.value);fset("product",e.target.value);setShowDropdown(true);}}
                        onFocus={()=>setShowDropdown(true)} onBlur={()=>setTimeout(()=>setShowDropdown(false),150)}
                        placeholder="Rechercher un produit..." style={INPUT} autoComplete="off"/>
                      {showDropdown&&search&&(
                        <div style={{position:"absolute",top:"100%",left:0,right:0,background:"white",border:"1px solid #ddd",borderRadius:7,maxHeight:220,overflowY:"auto",zIndex:50,boxShadow:"0 4px 12px rgba(0,0,0,0.1)"}}>
                          {filtered.map(p=>(
                            <div key={p.id} onMouseDown={()=>handleSelectProduct(p)}
                              style={{padding:"9px 12px",fontSize:13,cursor:"pointer",borderBottom:"1px solid #f5f5f5",display:"flex",justifyContent:"space-between"}}
                              onMouseEnter={e=>e.currentTarget.style.background="#f0faf5"}
                              onMouseLeave={e=>e.currentTarget.style.background="white"}>
                              <span style={{fontWeight:500}}>{p.name}</span>
                              <span style={{color:"#aaa",fontSize:11}}>{p.unit} · {p.category}</span>
                            </div>
                          ))}
                          <div onMouseDown={()=>{setCustomProduct(true);fset("product","");setSearch("");setShowDropdown(false);}}
                            style={{padding:"10px 12px",fontSize:13,cursor:"pointer",color:"#1d9e75",fontWeight:600,borderTop:"1px solid #eee",background:"#f0faf5"}}>
                            ➕ Nouveau produit
                          </div>
                        </div>
                      )}
                    </div>
                  ):(
                    <div>
                      <input value={form.product} onChange={e=>fset("product",e.target.value)} placeholder="Nom du nouveau produit" required style={INPUT} autoFocus/>
                      <button type="button" onClick={()=>{setCustomProduct(false);fset("product","");setSearch("");}}
                        style={{marginTop:6,fontSize:12,color:"#888",background:"none",border:"none",cursor:"pointer",textDecoration:"underline"}}>← Choisir depuis la liste</button>
                    </div>
                  )}
                </div>
                <div><label style={LABEL}>Quantite *</label><input type="number" value={form.quantity} onChange={e=>fset("quantity",e.target.value)} placeholder="0" required min="0" step="0.01" style={INPUT}/></div>
                <div><label style={LABEL}>Unite</label>
                  <select value={form.unit} onChange={e=>fset("unit",e.target.value)} style={INPUT}>
                    <option value="KG">KG</option><option value="L">L</option><option value="UNITE">UNITE</option>
                  </select>
                </div>
                {active==="consumption"&&<>
                  <div><label style={LABEL}>Culture</label>
                    <select value={form.culture} onChange={e=>fset("culture",e.target.value)} style={INPUT}>
                      {farmConfig.cultures.map(c=><option key={c}>{c}</option>)}
                    </select>
                  </div>
                  <div><label style={LABEL}>Destination</label>
                    <select value={form.destination} onChange={e=>fset("destination",e.target.value)} style={INPUT}>
                      <option value="">Selectionner</option>
                      {destinations.map(d=><option key={d}>{d}</option>)}
                    </select>
                  </div>
                </>}
                {active==="entry"&&<>
                  <div><label style={LABEL}>Fournisseur</label><input value={form.supplier} onChange={e=>fset("supplier",e.target.value)} placeholder="Nom fournisseur" style={INPUT}/></div>
                  <div><label style={LABEL}>Prix (MAD)</label><input type="number" value={form.price} onChange={e=>fset("price",e.target.value)} placeholder="0.00" min="0" step="0.01" style={INPUT}/></div>
                </>}
                {active==="transfer"&&(
                  <div style={{gridColumn:"1 / -1"}}><label style={LABEL}>Vers la ferme *</label>
                    <select value={form.toFarm} onChange={e=>fset("toFarm",e.target.value)} required style={INPUT}>
                      <option value="">Selectionner</option>
                      {FARMS.filter(fm=>fm!==farmName).map(fm=><option key={fm}>{fm}</option>)}
                    </select>
                  </div>
                )}
                <div style={{gridColumn:"1 / -1"}}><label style={LABEL}>Notes</label>
                  <textarea value={form.notes} onChange={e=>fset("notes",e.target.value)} placeholder="Informations supplementaires..." rows={2} style={{...INPUT,resize:"vertical"}}/>
                </div>
              </div>
              <button type="submit" disabled={loading}
                style={{width:"100%",padding:"12px",background:loading?"#aaa":activeMenu?.color||"#1d9e75",color:"white",border:"none",borderRadius:8,fontSize:15,fontWeight:600,cursor:loading?"not-allowed":"pointer"}}>
                {loading?"⏳ Enregistrement...":activeMenu?.icon+" Enregistrer dans le stock"}
              </button>
            </form>
          </div>
        )}

        {active==="history"&&(
          <div style={{maxWidth:720}}>
            {demandes.length===0?(
              <div style={{background:"white",borderRadius:12,padding:48,textAlign:"center",color:"#aaa"}}><div style={{fontSize:48,marginBottom:12}}>📋</div><p style={{margin:0}}>Aucune saisie</p></div>
            ):(
              <div style={{background:"white",borderRadius:12,overflow:"hidden",boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead><tr style={{background:"#f8f9fa"}}>
                    {["Date","Type","Produit","Qte","Detail","Statut"].map(h=>(
                      <th key={h} style={{padding:"12px 16px",textAlign:"left",fontSize:11,fontWeight:600,color:"#888",textTransform:"uppercase",borderBottom:"1px solid #eee"}}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {demandes.map((d,i)=>{
                      const m=MENUS.find(m=>m.id===d.type||(m.id==="transfer"&&d.type==="transfer-out"))||MENUS[1];
                      return(
                        <tr key={d.id} style={{borderBottom:"1px solid #f0f0f0",background:i%2===0?"white":"#fafafa"}}>
                          <td style={{padding:"12px 16px",fontSize:13,color:"#555"}}>{new Date(d.createdAt).toLocaleDateString("fr-FR")}</td>
                          <td style={{padding:"12px 16px"}}><span style={{background:m.color+"18",color:m.color,fontSize:12,padding:"3px 8px",borderRadius:5,fontWeight:600}}>{m.icon} {m.label}</span></td>
                          <td style={{padding:"12px 16px",fontSize:13,fontWeight:500}}>{d.product}</td>
                          <td style={{padding:"12px 16px",fontSize:13}}>{d.quantity} {d.unit}</td>
                          <td style={{padding:"12px 16px",fontSize:12,color:"#666"}}>{d.culture}{d.destination&&" · "+d.destination}{d.toFarm&&"→ "+d.toFarm}{d.supplier}</td>
                          <td style={{padding:"12px 16px"}}><span style={{background:"#EAF3DE",color:"#27500A",fontSize:11,padding:"2px 8px",borderRadius:5,fontWeight:600}}>✅ Enregistre</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}