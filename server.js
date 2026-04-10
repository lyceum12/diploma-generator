const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const QRCode = require('qrcode');
const puppeteer = require('puppeteer');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { initDB, getDB } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({ secret: 'secret', resave: false, saveUninitialized: false }));

// Создаём папку uploads
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
const upload = multer({ dest: './uploads/' });

let db;
initDB().then(d => { db = d; });

// ---- Аутентификация middleware ----
function isAuth(req, res, next) {
    if (req.session.admin) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ---- API для админ-панели ----
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const admin = await db.get('SELECT * FROM admins WHERE username = ?', username);
    if (admin && await bcrypt.compare(password, admin.password_hash)) {
        req.session.admin = { id: admin.id, username: admin.username };
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Неверные учётные данные' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/diplomas', isAuth, async (req, res) => {
    const diplomas = await db.all('SELECT * FROM diplomas ORDER BY id DESC');
    res.json(diplomas);
});

app.post('/api/diplomas', isAuth, async (req, res) => {
    const { full_name, grade, school, olympiad_name, profile, level, number_in_list, degree } = req.body;
    const unique_code = Math.floor(100 + Math.random() * 900) + ' ' + Math.floor(1000 + Math.random() * 9000) + '-' + Math.floor(10000 + Math.random() * 90000);
    const result = await db.run(`INSERT INTO diplomas (unique_code, full_name, grade, school, olympiad_name, profile, level, number_in_list, degree)
        VALUES (?,?,?,?,?,?,?,?,?)`, unique_code, full_name, grade, school, olympiad_name, profile, level, number_in_list, degree);
    res.json({ id: result.lastID, unique_code });
});

app.put('/api/diplomas/:id', isAuth, async (req, res) => {
    const { full_name, grade, school, olympiad_name, profile, level, number_in_list, degree } = req.body;
    await db.run(`UPDATE diplomas SET full_name=?, grade=?, school=?, olympiad_name=?, profile=?, level=?, number_in_list=?, degree=? WHERE id=?`,
        full_name, grade, school, olympiad_name, profile, level, number_in_list, degree, req.params.id);
    res.json({ success: true });
});

app.delete('/api/diplomas/:id', isAuth, async (req, res) => {
    await db.run('DELETE FROM diplomas WHERE id = ?', req.params.id);
    res.json({ success: true });
});

app.post('/api/change-password', isAuth, async (req, res) => {
    const { old_password, new_password } = req.body;
    const admin = await db.get('SELECT * FROM admins WHERE id = ?', req.session.admin.id);
    if (await bcrypt.compare(old_password, admin.password_hash)) {
        const newHash = await bcrypt.hash(new_password, 10);
        await db.run('UPDATE admins SET password_hash = ? WHERE id = ?', newHash, admin.id);
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'Старый пароль неверен' });
    }
});

app.get('/api/export-db', isAuth, (req, res) => {
    res.download(path.join(__dirname, 'database.sqlite'), 'database.sqlite');
});

app.post('/api/import-db', isAuth, upload.single('dbFile'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const newDbPath = req.file.path;
    const currentDbPath = path.join(__dirname, 'database.sqlite');
    await db.close();
    fs.copyFileSync(newDbPath, currentDbPath);
    fs.unlinkSync(newDbPath);
    const { initDB } = require('./database');
    db = await initDB();
    res.json({ success: true });
});

app.get('/api/diploma/:id/pdf', isAuth, async (req, res) => {
    const diploma = await db.get('SELECT * FROM diplomas WHERE id = ?', req.params.id);
    if (!diploma) return res.status(404).send('Not found');
    const verifyUrl = `${BASE_URL}/verify.html?code=${encodeURIComponent(diploma.unique_code)}`;
    const qrBase64 = await QRCode.toDataURL(verifyUrl, { width: 120 });
    
    const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><style>
        body { font-family: 'Times New Roman', serif; margin: 0; padding: 30px; background: white; }
        .diploma { width: 100%; max-width: 800px; margin: 0 auto; border: 2px solid #c9ae5d; padding: 30px; background: #fffef7; }
        .header { text-align: center; font-size: 18px; font-weight: bold; border-bottom: 2px solid #c9ae5d; padding-bottom: 8px; margin-bottom: 20px; }
        .olympiad-name { font-size: 22px; font-weight: bold; text-align: center; margin: 15px 0; }
        .info-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        .info-table td, .info-table th { border: 1px solid #d4c8a8; padding: 6px; }
        .legal { font-size: 11px; margin-top: 15px; }
        .verification { background: #faf7ef; padding: 10px; border-left: 4px solid #c9ae5d; margin: 15px 0; font-size: 12px; }
        .code { font-size: 20px; font-weight: bold; font-family: monospace; background: #f1ebda; display: inline-block; padding: 4px 12px; }
        .winner { display: flex; justify-content: space-between; margin-top: 20px; }
        .qr { text-align: center; }
        .sign { margin-top: 30px; border-top: 1px dashed #b89b4b; padding-top: 12px; display: flex; justify-content: space-between; font-size: 11px; }
    </style></head>
    <body>
    <div class="diploma">
        <div class="header">РОССИЙСКИЙ СОВЕТ ОЛИМПИАД ШКОЛЬНИКОВ</div>
        <div class="olympiad-name">${diploma.olympiad_name}</div>
        <table class="info-table">
            <tr><th>Профиль олимпиады</th><td>${diploma.profile}</td></tr>
            <tr><th>Уровень олимпиады</th><td>${diploma.level}</td></tr>
            <tr><th>Номер олимпиады в Перечне</th><td>${diploma.number_in_list}</td></tr>
            <tr><th>Степень диплома</th><td>${diploma.degree}</td></tr>
        </table>
        <div class="legal">Список организаторов и уровень олимпиады утверждены приказом Министерства науки и высшего образования Российской Федерации №571 от 30.08.2024</div>
        <div class="verification">
            <strong>Подтверждение:</strong> С 2016 года бумажные и электронные копии дипломов требуют подтверждения статуса через ФИС ГИА и приема.<br>
            Проверить диплом: ${verifyUrl}
        </div>
        <div><span>Код подтверждения:</span> <span class="code">${diploma.unique_code}</span></div>
        <div class="winner">
            <div>
                <p><strong>Награждается</strong><br><span style="font-size:18px;font-weight:bold">${diploma.full_name}</span></p>
                <p><strong>Класс:</strong> ${diploma.grade}<br><strong>Учреждение:</strong> ${diploma.school}</p>
                <p><em>олимпиадные задания выполнены за ${diploma.grade} класс</em></p>
            </div>
            <div class="qr"><img src="${qrBase64}" width="100"><div style="font-size:9px">Проверка по QR</div></div>
        </div>
        <div class="sign"><span>Председатель РСОШ</span><span>М.П.</span><span>2025 г.</span></div>
    </div>
    </body>
    </html>`;
    
    const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=diplom_${diploma.unique_code}.pdf`);
    res.send(pdf);
});

// ---- Отдача статических HTML ----
app.get('/', (req, res) => res.redirect('/admin_login.html'));

app.listen(PORT, () => console.log(`Сервер на ${BASE_URL}`));
