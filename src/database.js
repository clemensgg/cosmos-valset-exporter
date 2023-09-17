const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./valset_hashes.sqlite');

function initializeDB() {
    db.run("CREATE TABLE IF NOT EXISTS valset_hashes (height INTEGER PRIMARY KEY, hash TEXT)");
}

module.exports = {
    db,
    initializeDB
};
