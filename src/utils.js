const crypto = require('crypto');
const { db } = require('./database');

function generateValsetHash(validatorSet) {
    const cleanedValidatorSet = validatorSet.map(({ proposer_priority, pub_key, ...validator }) => validator);
    const sortedValidatorSet = cleanedValidatorSet.sort((a, b) => b.address - a.address);
    const serializedValidatorSet = JSON.stringify(sortedValidatorSet);
    const hash = crypto.createHash('sha256').update(serializedValidatorSet).digest('hex');
    return hash;
}

async function checkValsetHashExists(valsetHash) {
    return new Promise((resolve, reject) => {
        db.get("SELECT hash FROM valset_hashes WHERE hash = ?", [valsetHash], (err, row) => {
            if (err) {
                reject(err);
            } else {
                resolve(!!row);
            }
        });
    });
}

module.exports = {
    generateValsetHash,
    checkValsetHashExists
};
