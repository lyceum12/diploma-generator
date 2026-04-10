require('dotenv').config();
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

// middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use(session({ secret: 'secretkey', resave: false, saveUninitialized: false }));
app.set('view engine', 'ejs');
app.set('views', './views');

// создаём папку uploads
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
const upload = multer({ dest: './uploads/' });

// инициализация БД
let db;
(async () => { db = await initDB(); })();

// -------- Middleware аутентификации --------
function isAuth(req, res, next) {
    if (req.session.admin) return next();
    res.redirect('/admin/login');
}

// -------- Админ-панель --------
app.get('/admin/login', (req, res) => res.render('admin_login', { error: null }));
app.post('/admin/login', async (req, res) => {
    const { username, password } = req.body;
    const admin = await db.get('SELECT * FROM admins WHERE username = ?', username);
    if (admin && await bcrypt.compare(password, admin.password_hash)) {
        req.session.admin = { id: admin.id, username: admin.username };
        res.redirect('/admin/dashboard');
    } else res.render('admin_login', { error: 'Неверные учётные данные' });
});
app.get('/admin/logout', (req, res) => { req.session.destroy(); res.redirect('/admin/login'); });

app.get('/admin/dashboard', isAuth, async (req, res) => {
    const diplomas = await db.all('SELECT * FROM diplomas ORDER BY id DESC');
    res.render('admin_dashboard', { diplomas, admin: req.session.admin });
});

app.get('/admin/create', isAuth, (req, res) => res.render('admin_dashboard', { editing: null, diploma: null, admin: req.session.admin }));
app.post('/admin/create', isAuth, async (req, res) => {
    const { full_name, grade, school, olympiad_name, profile, level, number_in_list, degree } = req.body;
    const unique_code = Math.floor(100 + Math.random() * 900) + ' ' + Math.floor(1000 + Math.random() * 9000) + '-' + Math.floor(10000 + Math.random() * 90000);
    await db.run(`INSERT INTO diplomas (unique_code, full_name, grade, school, olympiad_name, profile, level, number_in_list, degree)
                  VALUES (?,?,?,?,?,?,?,?,?)`, unique_code, full_name, grade, school, olympiad_name, profile, level, number_in_list, degree);
    res.redirect('/admin/dashboard');
});

app.get('/admin/edit/:id', isAuth, async (req, res) => {
    const diploma = await db.get('SELECT * FROM diplomas WHERE id = ?', req.params.id);
    res.render('admin_dashboard', { editing: diploma, diploma: null, admin: req.session.admin });
});
app.post('/admin/edit/:id', isAuth, async (req, res) => {
    const { full_name, grade, school, olympiad_name, profile, level, number_in_list, degree } = req.body;
    await db.run(`UPDATE diplomas SET full_name=?, grade=?, school=?, olympiad_name=?, profile=?, level=?, number_in_list=?, degree=? WHERE id=?`,
        full_name, grade, school, olympiad_name, profile, level, number_in_list, degree, req.params.id);
    res.redirect('/admin/dashboard');
});

app.post('/admin/delete/:id', isAuth, async (req, res) => {
    await db.run('DELETE FROM diplomas WHERE id = ?', req.params.id);
    res.redirect('/admin/dashboard');
});

app.get('/admin/change-password', isAuth, (req, res) => res.render('admin_change_password', { error: null, admin: req.session.admin }));
app.post('/admin/change-password', isAuth, async (req, res) => {
    const { old_password, new_password } = req.body;
    const admin = await db.get('SELECT * FROM admins WHERE id = ?', req.session.admin.id);
    if (await bcrypt.compare(old_password, admin.password_hash)) {
        const newHash = await bcrypt.hash(new_password, 10);
        await db.run('UPDATE admins SET password_hash = ? WHERE id = ?', newHash, admin.id);
        res.redirect('/admin/dashboard');
    } else res.render('admin_change_password', { error: 'Старый пароль неверен', admin: req.session.admin });
});

// экспорт базы данных
app.get('/admin/export-db', isAuth, (req, res) => {
    res.download(path.join(__dirname, 'database.sqlite'), 'database.sqlite');
});
// импорт базы данных (заменяет текущую)
app.post('/admin/import-db', isAuth, upload.single('dbFile'), async (req, res) => {
    if (!req.file) return res.redirect('/admin/dashboard');
    const newDbPath = req.file.path;
    const currentDbPath = path.join(__dirname, 'database.sqlite');
    // закрываем текущее соединение
    await db.close();
    // заменяем файл
    fs.copyFileSync(newDbPath, currentDbPath);
    fs.unlinkSync(newDbPath);
    // переоткрываем
    const { initDB } = require('./database');
    db = await initDB();
    res.redirect('/admin/dashboard');
});

// -------- Генерация PDF диплома --------
app.get('/diploma/:id/pdf', isAuth, async (req, res) => {
    const diploma = await db.get('SELECT * FROM diplomas WHERE id = ?', req.params.id);
    if (!diploma) return res.status(404).send('Диплом не найден');
    const verifyUrl = `${BASE_URL}/verify?code=${encodeURIComponent(diploma.unique_code)}`;
    const qrBase64 = await QRCode.toDataURL(verifyUrl, { width: 120 });
    const html = await require('ejs').renderFile(path.join(__dirname, 'views', 'diploma_template.ejs'), { diploma, qrBase64, verifyUrl });
    const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=diplom_${diploma.unique_code}.pdf`);
    res.send(pdf);
});

// -------- Страница проверки диплома --------
app.get('/verify', async (req, res) => {
    const code = req.query.code || '';
    let diploma = null;
    if (code) diploma = await db.get('SELECT * FROM diplomas WHERE unique_code = ?', code);
    res.render('verify', { diploma, code });
});
app.post('/verify', async (req, res) => {
    const { code } = req.body;
    const diploma = await db.get('SELECT * FROM diplomas WHERE unique_code = ?', code);
    res.render('verify', { diploma, code });
});

app.listen(PORT, () => console.log(`Сервер запущен на ${BASE_URL}`));