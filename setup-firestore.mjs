import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAe6s0TZMRiWCNqMXp1Agxl_bEPsENx8eI",
  authDomain: "agro-berry-manager.firebaseapp.com",
  projectId: "agro-berry-manager",
  storageBucket: "agro-berry-manager.firebasestorage.app",
  messagingSenderId: "245632450854",
  appId: "1:245632450854:web:dcc79fe00d048bfb5681e7"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const users = [
  { uid: "iq5k2YP8SIhR1QDGj70jdmdMgyw1", data: { role: "admin", farm: "AGRO BERRY 1", farmId: "AGB1", email: "echennoufiahmed@gmail.com" } },
  { uid: "dN0UnDwCKtZdDRWHxJTHFp2hU853", data: { role: "magasinier", farm: "AGRO BERRY 2", farmId: "AGB2", email: "agb2@agroberry.ma" } },
  { uid: "RqjChlmHfKUgWdnub1b2lpvJYPD3", data: { role: "magasinier", farm: "AGRO BERRY 3", farmId: "AGB3", email: "agb3@agroberry.ma" } }
];

async function setup() {
  console.log("Configuration Firestore...");
  for (const user of users) {
    await setDoc(doc(db, "users", user.uid), user.data);
    console.log("OK : " + user.data.farm);
  }
  console.log("Termine !");
  process.exit(0);
}

setup().catch(console.error);
