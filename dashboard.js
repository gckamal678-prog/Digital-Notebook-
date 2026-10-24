"use strict";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDDY_v7RHnkCTI6uyV4DNDjqoaIBGweg8c",
  authDomain: "digital-a2552.firebaseapp.com",
  databaseURL: "https://digital-a2552-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "digital-a2552",
  storageBucket: "digital-a2552.firebasestorage.app",
  messagingSenderId: "218135618179",
  appId: "1:218135618179:web:821b76920d3e5669ac31b6"
};

const $ = id => document.getElementById(id);

const LOCAL = {
  incomes: ["digital_notebook_incomes", "incomes", "income_data", "add_income_list"],
  transactions: ["digital_notebook_transactions", "transactions", "transaction_list"],
  notes: ["advanced_notebook_notes", "notes"],
  savings: ["digital_notebook_savings", "savings", "saving_data", "add_saving_list"],
  house: ["digital_notebook_house_expenses", "house_expenses", "houseExpenses", "house_expense_list"]
};

let app, auth, db, uid = null;
let mode = "login";
let privacy = localStorage.getItem("balance_privacy") === "hidden";
let listeners = [];
let cloudData = {};
let localRecords = {};
let saveReminderBusy = false;

try {
  app = firebase.initializeApp(FIREBASE_CONFIG);
  auth = firebase.auth();
  db = firebase.database();
} catch (error) {
  console.error("Firebase initialization failed", error);
  $("auth-error").textContent =
    "Firebase could not start. Check your connection and Firebase configuration.";
}

function parseJSON(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function number(value) {
  if (typeof value === "string") value = value.replace(/[,\s]/g, "");
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = String(value ?? "");
}

function readSettings() {
  const s = parseJSON(
    localStorage.getItem("digital_notebook_settings") || "{}",
    {}
  ) || {};

  return {
    theme: s.theme || localStorage.getItem("theme") || "dark",
    accentColor: s.accentColor || "#10b981",
    font_size: s.font_size || "16",
    font_family: s.font_family || "Poppins",
    layout: s.layout || "comfortable",
    lang: s.lang || "en"
  };
}

function applySettings() {
  const s = readSettings();
  const root = document.documentElement;

  root.classList.toggle("dark", s.theme === "dark");
  root.classList.toggle("light", s.theme === "light");
  root.lang = s.lang === "ne" ? "ne" : "en";

  root.style.setProperty(
    "--accent",
    /^#[0-9a-f]{6}$/i.test(s.accentColor) ? s.accentColor : "#10b981"
  );

  root.style.setProperty(
    "--app-font-size",
    Math.max(12, Math.min(24, number(s.font_size) || 16)) + "px"
  );

  const fonts = ["Poppins", "Arial", "Roboto", "Georgia", "system-ui"];
  root.style.setProperty(
    "--app-font-family",
    (fonts.includes(s.font_family) ? s.font_family : "Poppins") +
      ", Arial, sans-serif"
  );

  root.dataset.layout = s.layout === "compact" ? "compact" : "comfortable";
  document.body.dataset.layout = root.dataset.layout;

  const words = s.lang === "ne"
    ? { overview: "तपाईंको आर्थिक विवरण" }
    : { overview: "Your financial overview" };

  document.querySelectorAll("[data-en][data-ne]").forEach(el => {
    el.textContent = s.lang === "ne" ? el.dataset.ne : el.dataset.en;
  });

  const subtitle = document.querySelector(".subtitle");
  if (subtitle) subtitle.textContent = words.overview;

  renderDashboard();
}

window.addEventListener("storage", event => {
  if (["digital_notebook_settings", "theme", "balance_privacy"].includes(event.key)) {
    if (event.key === "balance_privacy") {
      privacy = localStorage.getItem("balance_privacy") === "hidden";
    }
    applySettings();
  }

  if (Object.values(LOCAL).flat().includes(event.key)) {
    loadLocalFallback();
    renderDashboard();
  }
});

window.addEventListener("focus", applySettings);
window.addEventListener("pageshow", applySettings);

function amount(record) {
  if (!record || typeof record !== "object") return 0;

  const keys = [
    "total",
    "amount",
    "incomeAmount",
    "savingAmount",
    "txAmount",
    "principalAmount",
    "val",
    "price",
    "npr",
    "totalAmount",
    "expenseAmount"
  ];

  for (const key of keys) {
    if (
      record[key] !== undefined &&
      record[key] !== null &&
      record[key] !== ""
    ) {
      return number(record[key]);
    }
  }

  return 0;
}

function recordType(record) {
  return String(
    record?.type ||
    record?.category ||
    record?.transactionType ||
    record?.action ||
    record?.kind ||
    record?.transaction_type ||
    ""
  ).toLowerCase().trim();
}

function recordDate(record) {
  const raw =
    record?.date ||
    record?.dateExpense ||
    record?.createdAt ||
    record?.timestamp ||
    record?.datedAt ||
    record?.created_at ||
    "";

  if (!raw) return null;

  let date;

  if (typeof raw === "number") {
    date = new Date(raw < 100000000000 ? raw * 1000 : raw);
  } else {
    date = new Date(raw);
  }

  return Number.isNaN(date.getTime()) ? null : date;
}

function isDeleted(record) {
  return !!(
    record?.deletedAt ||
    record?.isDeleted ||
    record?.deleted === true
  );
}

function normalizeRecords(raw) {
  if (!raw || typeof raw !== "object") return [];

  const entries = Array.isArray(raw)
    ? raw.map((value, index) => [String(index), value])
    : Object.entries(raw);

  return entries
    .filter(([, record]) =>
      record &&
      typeof record === "object" &&
      !Array.isArray(record)
    )
    .map(([id, record]) => ({
      ...record,
      id: String(record.id || id)
    }))
    .filter(record => !isDeleted(record));
}

/*
 * Once Firebase has returned a value for a section, that cloud value is
 * authoritative for the dashboard. An empty cloud section must not cause
 * stale local records to be displayed as if they were current cloud data.
 */
function getRecords(path) {
  if (Object.prototype.hasOwnProperty.call(cloudData, path)) {
    return normalizeRecords(cloudData[path]);
  }

  return localRecords[path] || [];
}

function loadLocalFallback() {
  for (const [path, keys] of Object.entries(LOCAL)) {
    let records = [];

    for (const key of keys) {
      const parsed = parseJSON(localStorage.getItem(key) || "null");

      if (Array.isArray(parsed) && parsed.length) {
        records = normalizeRecords(parsed);
        break;
      }

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        records = normalizeRecords(parsed);
        break;
      }
    }

    localRecords[path] = records;
  }
}

function money(value) {
  return privacy
    ? "••••••"
    : "NPR " + Math.round(number(value)).toLocaleString("en-IN");
}

function monthMatch(record, year, month) {
  const date = recordDate(record);

  return !!date &&
    date.getFullYear() === year &&
    date.getMonth() === month;
}

function isExpense(record) {
  const type = recordType(record);

  return type.includes("expense") ||
    type.includes("खर्च") ||
    type.includes("invest") ||
    type === "cost" ||
    type === "expenditure";
}

function isReceivable(record) {
  const type = recordType(record);

  return type.includes("receivable") ||
    type.includes("receive") ||
    type.includes("लिनुपर्ने") ||
    type.includes("पाउनुपर्ने") ||
    type === "lend" ||
    type === "loan given";
}

function isPayable(record) {
  const type = recordType(record);

  return type.includes("payable") ||
    type.includes("give") ||
    type.includes("दिनुपर्ने") ||
    type.includes("दिनु") ||
    type === "pay" ||
    type === "loan taken";
}

function renderDashboard() {
  const incomeRecords = getRecords("incomes");
  const savingsRecords = getRecords("savings");
  const transactionRecords = getRecords("transactions");
  const houseRecords = getRecords("house");

  const activeTransactions = transactionRecords.filter(record => !isDeleted(record));
  const activeHouseExpenses = houseRecords.filter(record => !isDeleted(record));
  const activeIncomes = incomeRecords.filter(record => !isDeleted(record));
  const activeSavings = savingsRecords.filter(record => !isDeleted(record));

  const now = new Date();

  const totalIncome = activeIncomes.reduce(
    (sum, record) => sum + amount(record),
    0
  );

  const totalReceivable = activeTransactions
    .filter(isReceivable)
    .reduce((sum, record) => sum + amount(record), 0);

  const totalPayable = activeTransactions
    .filter(isPayable)
    .reduce((sum, record) => sum + amount(record), 0);

  const totalTransactionExpenses = activeTransactions
    .filter(isExpense)
    .reduce((sum, record) => sum + amount(record), 0);

  const totalHouseExpenses = activeHouseExpenses
    .reduce((sum, record) => sum + amount(record), 0);

  /*
   * Required formula:
   * Income + Receivable - Payable - Transaction Expense - House Expense.
   * Savings are deliberately excluded from Net Balance.
   */
  const netBalance =
    totalIncome +
    totalReceivable -
    totalPayable -
    totalTransactionExpenses -
    totalHouseExpenses;

  const monthIncome = activeIncomes
    .filter(record => monthMatch(record, now.getFullYear(), now.getMonth()))
    .reduce((sum, record) => sum + amount(record), 0);

  const monthSavings = activeSavings
    .filter(record => monthMatch(record, now.getFullYear(), now.getMonth()))
    .reduce((sum, record) => sum + amount(record), 0);

  const monthTransactionExpenses = activeTransactions
    .filter(record =>
      monthMatch(record, now.getFullYear(), now.getMonth()) &&
      isExpense(record)
    )
    .reduce((sum, record) => sum + amount(record), 0);

  const monthHouseExpenses = activeHouseExpenses
    .filter(record =>
      monthMatch(record, now.getFullYear(), now.getMonth())
    )
    .reduce((sum, record) => sum + amount(record), 0);

  const monthExpenses = monthTransactionExpenses + monthHouseExpenses;

  setText("summary-net-balance", money(netBalance));
  setText("summary-receivable", money(totalReceivable));
  setText("summary-payable", money(totalPayable));
  setText("summary-expenses", money(monthExpenses));

  setText("monthly-income", money(monthIncome));
  setText("monthly-expenses", money(monthExpenses));
  setText("monthly-savings", money(monthSavings));

  setText(
    "insight-month-label",
    now.toLocaleDateString(
      readSettings().lang === "ne" ? "ne-NP" : "en-IN",
      { month: "long", year: "numeric" }
    )
  );

  setText(
    "monthly-insight",
    "This month: " + money(monthIncome) +
    " income · " + money(monthExpenses) +
    " expenses · " + money(monthSavings) + " savings."
  );

  const displayName =
    localStorage.getItem("profile_name") ||
    localStorage.getItem("user_profile_name") ||
    "";

  setText("greeting", displayName ? "Welcome, " + displayName : "Welcome");

  const allActivity = [
    ...activeIncomes.map(record => ({ ...record, _kind: "Income" })),
    ...activeSavings.map(record => ({ ...record, _kind: "Saving" })),
    ...activeTransactions.map(record => ({ ...record, _kind: "Transaction" })),
    ...activeHouseExpenses.map(record => ({ ...record, _kind: "House Expense" }))
  ];

  allActivity.sort((a, b) => {
    const dateA = recordDate(a)?.getTime() || number(a.updatedAt);
    const dateB = recordDate(b)?.getTime() || number(b.updatedAt);
    return dateB - dateA;
  });

  renderRecent(allActivity.slice(0, 5));
  renderDueAlerts(activeTransactions);
}

function renderDueAlerts(records) {
  const root = $("due-alerts");
  if (!root) return;

  root.replaceChildren();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dueRecords = records
    .filter(record =>
      typeof record.dueDate === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(record.dueDate)
    )
    .map(record => {
      const [year, month, day] = record.dueDate.split("-").map(Number);
      const due = new Date(year, month - 1, day);

      if (
        due.getFullYear() !== year ||
        due.getMonth() !== month - 1 ||
        due.getDate() !== day
      ) {
        return null;
      }

      return {
        ...record,
        _dueDateObject: due,
        _daysLeft: Math.round((due - today) / 86400000)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a._dueDateObject - b._dueDateObject)
    .slice(0, 8);

  if (!dueRecords.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent =
      "No due dates recorded. Add a due date to a transaction to see alerts here.";
    root.appendChild(p);
    return;
  }

  for (const record of dueRecords) {
    const row = document.createElement("div");
    row.className = "activity-row";

    const left = document.createElement("div");
    left.style.minWidth = "0";

    const title = document.createElement("strong");
    title.className = "activity-title";
    title.textContent =
      record.party || record.title || record.name || "Transaction";

    const sub = document.createElement("span");
    sub.className = "activity-sub";
    sub.textContent = (record.type || "Transaction") + " · Due " + record.dueDate;

    const right = document.createElement("span");
    right.className = "activity-amount";

    if (record._daysLeft < 0) {
      right.textContent = "Overdue " + Math.abs(record._daysLeft) + "d";
    } else if (record._daysLeft === 0) {
      right.textContent = "Due today";
    } else {
      right.textContent = record._daysLeft + " day(s) left";
    }

    right.style.color =
      record._daysLeft <= 3 ? "#fb7185" : "var(--accent)";

    left.append(title, sub);
    row.append(left, right);
    root.appendChild(row);
  }
}

function renderRecent(records) {
  const root = $("recent-activity");
  root.replaceChildren();

  if (!records.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No recent records available.";
    root.appendChild(p);
    return;
  }

  for (const record of records) {
    const row = document.createElement("div");
    row.className = "activity-row";

    const left = document.createElement("div");
    left.style.minWidth = "0";

    const title = document.createElement("strong");
    title.className = "activity-title";
    title.textContent =
      record.party ||
      record.title ||
      record.sourceName ||
      record.name ||
      record.description ||
      record._kind;

    const sub = document.createElement("span");
    sub.className = "activity-sub";

    const date = recordDate(record);
    sub.textContent =
      record._kind + (date ? " · " + date.toLocaleDateString() : "");

    const right = document.createElement("span");
    right.className = "activity-amount";
    right.textContent = money(amount(record));

    left.append(title, sub);
    row.append(left, right);
    root.appendChild(row);
  }
}

function applyProfile(profile = {}) {
  const name =
    profile.name ||
    localStorage.getItem("profile_name") ||
    localStorage.getItem("user_profile_name") ||
    "";

  $("profile-name").value = name;
  $("profile-address").value =
    profile.address || localStorage.getItem("profile_address") || "";
  $("profile-mobile").value =
    profile.mobile || localStorage.getItem("profile_mobile") || "";

  setText("sidebar-name", name || "My Account");
  setText("sidebar-email", auth?.currentUser?.email || "");

  const avatar = localStorage.getItem("profile_avatar") || "N1024.png";
  $("sidebar-avatar").src = avatar;
  $("header-avatar").src = avatar;

  setText("greeting", name ? "Welcome, " + name : "Welcome");
}

function listen(path) {
  const reference = db.ref("users/" + uid + "/" + path);

  const callback = snapshot => {
    if (auth.currentUser?.uid !== uid) return;

    cloudData[path] = snapshot.val();
    localRecords[path] = normalizeRecords(snapshot.val());

    const key = LOCAL[path]?.[0];

    if (key) {
      try {
        localStorage.setItem(key, JSON.stringify(localRecords[path]));
      } catch (_) {}
    }

    renderDashboard();
  };

  reference.on("value", callback, error => {
    console.error("Realtime listener failed:", path, error);
  });

  listeners.push(() => reference.off("value", callback));
}

function listenReminder() {
  const reference = db.ref("users/" + uid + "/dashboardReminder");

  const callback = snapshot => {
    if (auth.currentUser?.uid !== uid) return;

    const value = snapshot.val();

    if (document.activeElement !== $("reminder-text")) {
      $("reminder-text").value = value?.text || "";
    }

    if (value?.updatedAt) {
      setText("reminder-status", "Reminder synced.");
    }
  };

  reference.on("value", callback, error => {
    console.error("Reminder listener failed", error);
    setText(
      "reminder-status",
      "Could not load reminder. Check Firebase Rules and connection."
    );
  });

  listeners.push(() => reference.off("value", callback));
}

function listenProfile() {
  const reference = db.ref("users/" + uid + "/profile");

  const callback = snapshot => {
    if (auth.currentUser?.uid !== uid) return;
    applyProfile(snapshot.val() || {});
  };

  reference.on("value", callback, error => {
    console.error("Profile listener failed", error);
  });

  listeners.push(() => reference.off("value", callback));
}

function stopListeners() {
  listeners.forEach(stop => {
    try {
      stop();
    } catch (_) {}
  });

  listeners = [];
  cloudData = {};
}

function openSidebar(open) {
  $("sidebar").classList.toggle("hidden", !open);
  $("sidebar-backdrop").classList.toggle("hidden", !open);
}

if (auth && db) {
  auth.onAuthStateChanged(user => {
    stopListeners();
    uid = user?.uid || null;

    $("app").classList.toggle("hidden", !user);
    $("login-overlay").classList.toggle("hidden", !!user);

    if (!user) return;

    applySettings();
    loadLocalFallback();

    setText(
      "today",
      new Date().toLocaleDateString(
        readSettings().lang === "ne" ? "ne-NP" : "en-GB",
        { weekday: "long", year: "numeric", month: "long", day: "numeric" }
      )
    );

    ["incomes", "transactions", "notes", "savings", "house"].forEach(listen);
    listenReminder();
    listenProfile();
    renderDashboard();
  });
}

$("login-form").addEventListener("submit", async event => {
  event.preventDefault();

  if (!auth) {
    setText("auth-error", "Firebase could not start. Check your connection.");
    return;
  }

  setText("auth-error", "");
  $("auth-submit").disabled = true;

  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;

  try {
    if (mode === "signup") {
      if (password !== $("auth-confirm").value) {
        throw new Error("Passwords do not match.");
      }

      if (password.length < 6) {
        throw new Error("Password must contain at least 6 characters.");
      }

      await auth.createUserWithEmailAndPassword(email, password);
    } else {
      await auth.signInWithEmailAndPassword(email, password);
    }
  } catch (error) {
    const messages = {
      "auth/invalid-email": "Invalid email address.",
      "auth/invalid-credential": "Email or password is incorrect.",
      "auth/user-not-found": "Email or password is incorrect.",
      "auth/wrong-password": "Email or password is incorrect.",
      "auth/email-already-in-use": "This email is already registered.",
      "auth/weak-password": "Choose a stronger password.",
      "auth/network-request-failed": "Check your internet connection.",
      "auth/too-many-requests": "Too many attempts. Try again later."
    };

    setText(
      "auth-error",
      messages[error.code] || error.message || "Authentication failed."
    );
  } finally {
    $("auth-submit").disabled = false;
  }
});

$("auth-switch").addEventListener("click", () => {
  mode = mode === "login" ? "signup" : "login";

  setText(
    "auth-subtitle",
    mode === "login" ? "Login to your account" : "Create your account"
  );

  setText("auth-submit", mode === "login" ? "Login" : "Sign up");

  $("auth-confirm").classList.toggle("hidden", mode !== "signup");
  $("auth-confirm").required = mode === "signup";

  $("auth-password").autocomplete =
    mode === "login" ? "current-password" : "new-password";

  setText(
    "auth-switch",
    mode === "login"
      ? "Create a new account"
      : "Already have an account? Login"
  );

  $("auth-forgot").classList.toggle("hidden", mode !== "login");
  setText("auth-error", "");
});

$("auth-forgot").addEventListener("click", async () => {
  const email = $("auth-email").value.trim();

  if (!email) {
    setText("auth-error", "Enter your email address first.");
    return;
  }

  try {
    await auth.sendPasswordResetEmail(email);
    setText(
      "auth-error",
      "Password reset email sent. Check your inbox and spam folder."
    );
  } catch (error) {
    setText(
      "auth-error",
      "Could not send reset email: " + (error.code || "unknown error")
    );
  }
});

$("logout-button").addEventListener("click", async () => {
  if (auth) await auth.signOut();
});

$("open-sidebar").addEventListener("click", () => openSidebar(true));
$("close-sidebar").addEventListener("click", () => openSidebar(false));
$("sidebar-backdrop").addEventListener("click", () => openSidebar(false));
$("header-avatar").addEventListener("click", () => openSidebar(true));

$("privacy-button").addEventListener("click", () => {
  privacy = !privacy;

  localStorage.setItem(
    "balance_privacy",
    privacy ? "hidden" : "visible"
  );

  $("privacy-icon").className =
    privacy ? "fa-solid fa-eye-slash" : "fa-solid fa-eye";

  renderDashboard();
});

if (privacy) {
  $("privacy-icon").className = "fa-solid fa-eye-slash";
}

$("save-profile").addEventListener("click", async () => {
  if (!uid || !db) return;

  const profile = {
    name: $("profile-name").value.trim(),
    address: $("profile-address").value.trim(),
    mobile: $("profile-mobile").value.trim(),
    email: auth.currentUser?.email || "",
    updatedAt: Date.now()
  };

  try {
    await db.ref("users/" + uid + "/profile").update(profile);

    localStorage.setItem("profile_name", profile.name);
    localStorage.setItem("user_profile_name", profile.name);
    localStorage.setItem("profile_address", profile.address);
    localStorage.setItem("profile_mobile", profile.mobile);

    applyProfile(profile);
    setText("reminder-status", "Profile saved and synced.");
  } catch (error) {
    console.error(error);
    setText(
      "reminder-status",
      "Profile could not sync. Check Firebase Rules and connection."
    );
  }
});

$("save-reminder").addEventListener("click", async () => {
  if (!uid || !db || saveReminderBusy) return;

  saveReminderBusy = true;
  $("save-reminder").disabled = true;

  try {
    await db.ref("users/" + uid + "/dashboardReminder").update({
      text: $("reminder-text").value.trim(),
      updatedAt: Date.now()
    });

    setText("reminder-status", "Reminder saved and synced across devices.");
  } catch (error) {
    console.error("Reminder save failed", error);
    setText(
      "reminder-status",
      "Could not save reminder. Check Firebase Rules and connection."
    );
  } finally {
    saveReminderBusy = false;
    $("save-reminder").disabled = false;
  }
});

$("clear-reminder").addEventListener("click", async () => {
  if (!uid || !db) return;
  if (!confirm("Clear the shared dashboard reminder?")) return;

  try {
    await db.ref("users/" + uid + "/dashboardReminder").update({
      text: "",
      updatedAt: Date.now()
    });

    $("reminder-text").value = "";
    setText("reminder-status", "Reminder cleared and synced.");
  } catch (error) {
    console.error(error);
    setText(
      "reminder-status",
      "Could not clear reminder. Check Firebase Rules and connection."
    );
  }
});

/*
 * Merge local records one at a time.
 * If a cloud record with the same ID already exists, leave it unchanged.
 * Never replace users/{uid} or a complete data section.
 */
async function backupData() {
  if (!uid || !db) return;
  if (!confirm("Merge this device's local records into the cloud?")) return;

  try {
    let inserted = 0;
    let skipped = 0;

    for (const [path] of Object.entries(LOCAL)) {
      const local = localRecords[path] || [];

      for (const original of local) {
        if (!original || typeof original !== "object") continue;

        const record = { ...original };
        let id = String(record.id || "").trim();

        if (!id || id.startsWith("legacy-") || /^\d+$/.test(id)) {
          id = db.ref("users/" + uid + "/" + path).push().key;
          if (!id) throw new Error("Could not create a record ID.");
          record.id = id;
        }

        const ref = db.ref("users/" + uid + "/" + path + "/" + id);

        const result = await ref.transaction(current => {
          if (current !== null) return;
          return record;
        }, undefined, false);

        if (result.committed) inserted++;
        else skipped++;
      }
    }

    setText(
      "reminder-status",
      "Merge finished. Added: " + inserted + "; existing IDs left unchanged: " + skipped + "."
    );
  } catch (error) {
    console.error("Backup failed", error);
    setText(
      "reminder-status",
      "Backup failed. Check internet and Firebase Rules."
    );
  }
}

async function restoreData() {
  if (!uid || !db) return;
  if (!confirm("Refresh local copies from cloud? This changes local copies only.")) return;

  try {
    const paths = Object.keys(LOCAL);

    const snapshots = await Promise.all(
      paths.map(path => db.ref("users/" + uid + "/" + path).once("value"))
    );

    let found = false;

    snapshots.forEach((snapshot, index) => {
      const path = paths[index];

      if (!snapshot.exists()) {
        cloudData[path] = null;
        localRecords[path] = [];
        try {
          localStorage.setItem(LOCAL[path][0], JSON.stringify([]));
        } catch (_) {}
        return;
      }

      found = true;
      const records = normalizeRecords(snapshot.val());

      localRecords[path] = records;
      cloudData[path] = snapshot.val();

      try {
        localStorage.setItem(LOCAL[path][0], JSON.stringify(records));
      } catch (_) {}
    });

    if (!found) {
      renderDashboard();
      setText("reminder-status", "No cloud records found. Local copies were refreshed as empty.");
      return;
    }

    renderDashboard();
    setText("reminder-status", "Local copies refreshed from cloud.");
  } catch (error) {
    console.error("Restore failed", error);
    setText(
      "reminder-status",
      "Restore failed. Check internet and Firebase Rules."
    );
  }
}

$("backup-button").addEventListener("click", backupData);
$("restore-button").addEventListener("click", restoreData);

applySettings();
loadLocalFallback();
renderDashboard();
