import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyAe6s0TZMRiWCNqMXp1Agxl_bEPsENx8eI",
  authDomain: "agro-berry-manager.firebaseapp.com",
  projectId: "agro-berry-manager",
  storageBucket: "agro-berry-manager.firebasestorage.app",
  messagingSenderId: "245632450854",
  appId: "1:245632450854:web:dcc79fe00d048bfb5681e7"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
