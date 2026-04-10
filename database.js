const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const bcrypt = require('bcrypt');
let db;

async function initDB() {
    db = await open({
        filename: path.join(__dirname, 'database.sqlite'),
        driver: sqlite3.Database
    });
    await db.exec(`
        CREATE TABLE IF NOT EXISTS diplomas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            unique_code TEXT UNIQUE NOT NULL,
            full_name TEXT NOT NULL,
            grade TEXT NOT NULL,
            school TEXT NOT NULL,
            olympiad_name TEXT NOT NULL,
            profile TEXT NOT NULL,
            level TEXT NOT NULL,
            number_in_list TEXT NOT NULL,
            degree TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL
        )
    `);
    const adminExists = await db.get('SELECT * FROM admins WHERE username = ?', 'admin');
    if (!adminExists) {
        const hash = await bcrypt.hash('admin', 10);
        await db.run('INSERT INTO admins (username, password_hash) VALUES (?, ?)', 'admin', hash);
    }
    return db;
}

function getDB() { return db; }
module.exports = { initDB, getDB };