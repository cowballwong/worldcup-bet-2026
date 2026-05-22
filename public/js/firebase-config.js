// Firebase web config for the worldcup-bet-2026 project.
// Safe to commit (these are public client keys — Firestore rules enforce security).
// If you ever rotate keys, paste the new ones here and redeploy.
export const firebaseConfig = {
  apiKey: "AIzaSyCNwMFWLo2WP6la9bx2rdwIoeEsv-6uNEM",
  authDomain: "worldcup-bet-2026.firebaseapp.com",
  projectId: "worldcup-bet-2026",
  storageBucket: "worldcup-bet-2026.firebasestorage.app",
  messagingSenderId: "86821717864",
  appId: "1:86821717864:web:da7cccea18b7ffe47db8dd",
  measurementId: "G-TJ8ZWB4NS8"
};

export const APP_CONFIG = {
  startingBalance: 1000,
  minStake: 10,
  maxStake: 200,
  betCutoffMinutes: 0,  // 0 = closes exactly at kickoff
};
