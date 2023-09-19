import sqlite3 from 'sqlite3';

const db = new sqlite3.Database('./valset_db.sqlite');

function initializeDB() {
    db.run("CREATE TABLE IF NOT EXISTS valset_hashes (height INTEGER PRIMARY KEY, hash TEXT)");
}

export {
    db,
    initializeDB
};