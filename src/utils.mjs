import crypto from 'crypto';
import bech32 from 'bech32';
import { db } from './database.mjs';

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

function pubKeyToValcons(pubkey, prefix) {
    const consensusPubkeyBytes = Buffer.from(pubkey, 'base64');
    const sha256Hash = crypto.createHash('sha256').update(consensusPubkeyBytes).digest();
    const addressBytes = sha256Hash.slice(0, 20);
    const valconsAddress = bech32.bech32.encode(prefix + 'valcons', bech32.bech32.toWords(addressBytes));
    return valconsAddress;
}

export {
    generateValsetHash,
    checkValsetHashExists,
    pubKeyToValcons
};
