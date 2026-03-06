// --- 1. CONFIGURATION ---
const CLIENT_ID = '747138722746-5moie20nkh3hgpkrhfb4gmvmkiadjbku.apps.googleusercontent.com';
const API_KEY = 'AIzaSyA3v6zEyQhRq8X-PW0HG1eqhdmk8wbSg8s';
const SPREADSHEET_ID = '1UpHxRuvfYWguE78__bYR2sfjxRn6sskqOa5Po7XUoCU';
const OWNER_EMAIL = 'krishnahospitalsapotra@gmail.com'; // Admin account

const DISCOVERY_DOC = 'https://sheets.googleapis.com/$discovery/rest?version=v4';
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile';

let tokenClient, gisInited = false, gapiInited = false, accessToken = null;
let currentUser = null, currentStoreData = null, staffPhoto = null;

// --- 2. INITIALIZATION ---

async function initializeApp() {
    gapi.load('client', async () => {
        await gapi.client.init({ apiKey: API_KEY, discoveryDocs: [DISCOVERY_DOC] });
        gapiInited = true;
        autoLogin();
    });

    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID, scope: SCOPES,
        callback: async (resp) => {
            if (resp.error) return;
            accessToken = resp.access_token;
            gapi.client.setToken({ access_token: accessToken });
            localStorage.setItem('at_token', accessToken);
            localStorage.setItem('at_expiry', Date.now() + 3500000);
            loadProfile();
        }
    });
    gisInited = true;
}

async function initializeSheetStructure() {
    showLoader(true);
    try {
        // 1. Get current sheet metadata to see what tabs already exist
        const spreadsheet = await gapi.client.sheets.spreadsheets.get({
            spreadsheetId: SPREADSHEET_ID
        });
        
        const existingTabs = spreadsheet.result.sheets.map(s => s.properties.title);
        const requiredTabs = ['Stores', 'Employees', 'Attendance'];
        const missingTabs = requiredTabs.filter(tab => !existingTabs.includes(tab));

        // 2. Only create tabs that are actually missing
        if (missingTabs.length > 0) {
            const requests = missingTabs.map(title => ({
                addSheet: { properties: { title } }
            }));

            await gapi.client.sheets.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                resource: { requests }
            });
        }

        // 3. Update Headers for all tabs (safe to overwrite)
        const headerData = [
            { range: 'Stores!A1:D1', values: [['ID', 'Name', 'Lat', 'Lng']] },
            { range: 'Employees!A1:D1', values: [['Email', 'Name', 'StoreName', 'Status']] },
            { range: 'Attendance!A1:G1', values: [['Timestamp', 'Date', 'Email', 'Action', 'Photo', 'GPS', 'Device']] }
        ];

        for (let h of headerData) {
            await gapi.client.sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: h.range,
                valueInputOption: 'USER_ENTERED',
                resource: { values: h.values }
            });
        }

        showToast("Database Synced Successfully!", "success");
        document.getElementById('setup-card').classList.add('hidden');
        
        // Refresh views
        if (currentUser.email.toLowerCase() === OWNER_EMAIL.toLowerCase()) {
            setupAdminDashboard();
        } else {
            setupStaffDashboard(currentUser.email);
        }

    } catch (e) {
        console.error("Detailed Init Error:", e);
        const errorMsg = e.result?.error?.message || "Check API Permissions";
        showToast("Init Failed: " + errorMsg, "error");
    }
    showLoader(false);
}

function autoLogin() {
    const savedToken = localStorage.getItem('at_token');
    const expiry = localStorage.getItem('at_expiry');
    if (savedToken && expiry && Date.now() < parseInt(expiry)) {
        accessToken = savedToken;
        gapi.client.setToken({ access_token: accessToken });
        loadProfile();
    }
}

// --- 3. PROFILE & ROUTING ---

async function loadProfile() {
    showLoader(true);
    try {
        const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const userInfo = await resp.json();
        
        document.getElementById('login-view').classList.add('hidden');
        document.getElementById('user-badge').classList.remove('hidden');
        document.getElementById('user-display-name').innerText = userInfo.name || userInfo.email;

        // Show Admin Switch button if authorized
        if (userInfo.email.toLowerCase() === OWNER_EMAIL.toLowerCase()) {
            document.getElementById('admin-switch-btn').classList.remove('hidden');
        }

        // Landing page is always Employee View
        setupStaffDashboard(userInfo.email);
    } catch (e) {
        localStorage.clear();
        location.reload();
    }
    showLoader(false);
}

function switchView(view) {
    if (view === 'admin') {
        document.getElementById('staff-view').classList.add('hidden');
        document.getElementById('admin-view').classList.remove('hidden');
        showManager('stores');
        loadAdminStats();
    } else {
        document.getElementById('admin-view').classList.add('hidden');
        document.getElementById('staff-view').classList.remove('hidden');
    }
}

// --- 4. STAFF DASHBOARD LOGIC ---

async function setupStaffDashboard(email) {
    try {
        // Fetch Employee data
        const resp = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: 'Employees!A2:D'
        });
        
        const rows = resp.result.values || [];
        const emp = rows.find(r => r[0].toLowerCase() === email.toLowerCase());

        if (!emp) {
            // Check if we are admin, if so, show admin view
            if (email.toLowerCase() === OWNER_EMAIL.toLowerCase()) {
                switchView('admin');
                return;
            }
            alert("Access Denied: Email not found in Employee list.");
            return;
        }

        // Successfully found employee
        currentUser = { email: emp[0], name: emp[1], storeName: emp[2] };
        document.getElementById('staff-welcome').innerText = `Hello, ${currentUser.name}!`;
        document.getElementById('staff-store-tag').innerText = `Home Store: ${currentUser.storeName}`;
        
        // Load Store GPS
        const storeResp = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: 'Stores!A2:D'
        });
        const sRow = (storeResp.result.values || []).find(s => s[1] === currentUser.storeName);
        if (sRow) currentStoreData = { lat: parseFloat(sRow[2]), lng: parseFloat(sRow[3]) };

        checkTodayAttendance();
        setupCamera();
        loadPersonalHistory();
        document.getElementById('setup-card').classList.add('hidden');

    } catch (e) { 
        // If error is "400" it usually means the Tab doesn't exist
        if (e.status === 400) {
            console.warn("Tabs missing. Showing setup card.");
            document.getElementById('setup-card').classList.remove('hidden'); 
        } else {
            console.error("Dashboard Error:", e);
        }
    }
}

async function handlePunch(action) {
    showLoader(true);
    // Anti-Tamper Time via WorldTimeAPI
    const timeResp = await fetch('https://worldtimeapi.org/api/timezone/Etc/UTC').then(r => r.json()).catch(() => ({datetime: new Date().toISOString()}));
    const timestamp = timeResp.datetime;
    const date = new Date(timestamp).toLocaleDateString();

    const gps = await new Promise(res => navigator.geolocation.getCurrentPosition(p => res(`${p.coords.latitude},${p.coords.longitude}`)));

    try {
        await gapi.client.sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A:G',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[timestamp, date, currentUser.email, action, staffPhoto, gps, navigator.userAgent.slice(0, 30)]] }
        });
        showToast(`Attendance Marked: ${action}`, "success");
        setTimeout(() => location.reload(), 2000);
    } catch (e) {
        showToast("Error recording attendance", "error");
    }
    showLoader(false);
}

// --- 5. SMART MANAGER (ADMIN) ---

async function showManager(type) {
    const container = document.getElementById('manager-content');
    container.innerHTML = `<div class="p-10 flex justify-center"><div class="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin"></div></div>`;
    
    if (type === 'stores') {
        const resp = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Stores!A2:D' });
        const stores = resp.result.values || [];
        
        let html = `
            <div class="space-y-4">
                <div class="bg-indigo-50 p-4 rounded-xl space-y-2">
                    <p class="text-xs font-bold text-indigo-700">Add New Store</p>
                    <input id="mgr-st-name" placeholder="Store Name" class="w-full p-2 rounded-lg text-sm border-none">
                    <div class="flex gap-2">
                        <input id="mgr-st-lat" placeholder="Latitude" class="w-1/2 p-2 rounded-lg text-sm border-none">
                        <input id="mgr-st-lng" placeholder="Longitude" class="w-1/2 p-2 rounded-lg text-sm border-none">
                    </div>
                    <button onclick="adminAddStore()" class="w-full bg-indigo-600 text-white py-2 rounded-lg text-xs font-bold">SAVE STORE</button>
                </div>
                <div class="space-y-2 max-h-60 overflow-y-auto">
                    ${stores.map((s, i) => `
                        <div class="flex justify-between items-center p-3 bg-slate-50 rounded-xl text-xs">
                            <span><b>${s[1]}</b> (${s[2]}, ${s[3]})</span>
                            <button onclick="adminDeleteRow('Stores', ${i+2})" class="text-rose-500 font-bold">DEL</button>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        container.innerHTML = html;
    } else {
        const resp = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Employees!A2:D' });
        const storesResp = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Stores!B2:B' });
        const employees = resp.result.values || [];
        const stores = storesResp.result.values || [];

        let html = `
            <div class="space-y-4">
                <div class="bg-slate-100 p-4 rounded-xl space-y-2">
                    <p class="text-xs font-bold text-slate-700">Add Staff Member</p>
                    <input id="mgr-em-email" placeholder="Google Email" class="w-full p-2 rounded-lg text-sm border-none">
                    <input id="mgr-em-name" placeholder="Full Name" class="w-full p-2 rounded-lg text-sm border-none">
                    <select id="mgr-em-store" class="w-full p-2 rounded-lg text-sm border-none">
                        ${stores.map(s => `<option value="${s[0]}">${s[0]}</option>`).join('')}
                    </select>
                    <button onclick="adminAddEmployee()" class="w-full bg-slate-900 text-white py-2 rounded-lg text-xs font-bold">SAVE EMPLOYEE</button>
                </div>
                <div class="space-y-2 max-h-60 overflow-y-auto">
                    ${employees.map((e, i) => `
                        <div class="flex justify-between items-center p-3 bg-slate-50 rounded-xl text-[10px]">
                            <div><b>${e[1]}</b><br>${e[0]} (${e[2]})</div>
                            <button onclick="adminDeleteRow('Employees', ${i+2})" class="text-rose-500 font-bold">REMOVE</button>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        container.innerHTML = html;
    }
}

// --- 6. UTILITIES ---

async function adminAddStore() {
    const n = document.getElementById('mgr-st-name').value;
    const lt = document.getElementById('mgr-st-lat').value;
    const lg = document.getElementById('mgr-st-lng').value;
    if(!n || !lt || !lg) return;
    await gapi.client.sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: 'Stores!A:D',
        valueInputOption: 'USER_ENTERED', resource: { values: [[Date.now(), n, lt, lg]] }
    });
    showManager('stores');
}

async function adminAddEmployee() {
    const em = document.getElementById('mgr-em-email').value.toLowerCase();
    const nm = document.getElementById('mgr-em-name').value;
    const st = document.getElementById('mgr-em-store').value;
    if(!em || !nm || !st) return;
    await gapi.client.sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: 'Employees!A:D',
        valueInputOption: 'USER_ENTERED', resource: { values: [[em, nm, st, 'Active']] }
    });
    showManager('employees');
}

async function adminDeleteRow(tab, rowIdx) {
    if(!confirm("Are you sure you want to delete this?")) return;
    showLoader(true);
    // Note: Deleting rows requires a batchUpdate request
    const sheetResp = await gapi.client.sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheetId = sheetResp.result.sheets.find(s => s.properties.title === tab).properties.sheetId;

    await gapi.client.sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
            requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rowIdx-1, endIndex: rowIdx } } }]
        }
    });
    showLoader(false);
    showManager(tab.toLowerCase());
}

async function verifyGeofence() {
    navigator.geolocation.getCurrentPosition(pos => {
        const dist = calcDist(pos.coords.latitude, pos.coords.longitude, currentStoreData.lat, currentStoreData.lng);
        if (dist <= 0.15) { // 150m
            document.querySelectorAll('#punch-controls button, #punch-in-btn, #punch-out-btn').forEach(b => {
                b.disabled = false; b.classList.remove('opacity-50');
            });
            const sd = document.getElementById('status-display');
            sd.innerText = "📍 Location Verified: At Store";
            sd.classList.replace('text-slate-500', 'text-emerald-600');
        } else {
            showToast("You are outside the store range", "error");
        }
    });
}

function calcDist(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2-lat1)*Math.PI/180;
    const dLon = (lon2-lon1)*Math.PI/180;
    const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)*Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Global UI Helpers
function showLoader(s) { document.getElementById('loader').classList.toggle('hidden', !s); }
function showToast(m, t) {
    const el = document.createElement('div'); el.className = `toast ${t}`; el.innerText = m;
    document.body.appendChild(el); setTimeout(() => el.remove(), 3000);
}

// Camera Capture
document.getElementById('capture-btn').onclick = () => {
    const canvas = document.getElementById('canvas');
    const video = document.getElementById('video');
    canvas.width = 300; canvas.height = 300;
    canvas.getContext('2d').drawImage(video, 0, 0, 300, 300);
    staffPhoto = canvas.toDataURL('image/jpeg', 0.5);
    document.getElementById('photo-preview').src = staffPhoto;
    document.getElementById('photo-preview').classList.remove('hidden');
    verifyGeofence();
};

async function setupCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
        document.getElementById('video').srcObject = stream;
    } catch (e) { showToast("Camera access denied", "error"); }
}

window.onload = initializeApp;
document.getElementById('login-btn').onclick = () => tokenClient.requestAccessToken();
document.getElementById('punch-in-btn').onclick = () => handlePunch('IN');
document.getElementById('punch-out-btn').onclick = () => handlePunch('OUT');