'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    parseGeneralKey,
    parseKeyBatch,
    summarizeGeneralKeys,
} = require('../key-metadata-parser');

const GENERAL_KEYS = [
    'RingCentral.jedi.4ac1be6d554451a0415e6f74fc494588.DispositionCodeRequired',
    'RingCentral.jedi.c90bb9859cb0a22d4efea3e59c7cc8df.AuditTrail_#@#*Template*#@#_ChangeByEmbeddedApp',
    'RingCentral.mobileWeb.0a6876c6242797584e9063a58bde9578.extensions.ANNOUNCEMENT_ONLY_EXT_ADD_PROMPT',
];

test('parseGeneralKey extracts project, hash, feature, and key path metadata', () => {
    const item = parseGeneralKey(GENERAL_KEYS[2]);
    assert.ok(item);
    assert.equal(item.keyType, 'general');
    assert.equal(item.namespace, 'RingCentral');
    assert.equal(item.project, 'mobileWeb');
    assert.equal(item.hash, '0a6876c6242797584e9063a58bde9578');
    assert.equal(item.keyPath, 'extensions.ANNOUNCEMENT_ONLY_EXT_ADD_PROMPT');
    assert.deepEqual(item.pathSegments, ['extensions', 'ANNOUNCEMENT_ONLY_EXT_ADD_PROMPT']);
    assert.equal(item.pathDepth, 2);
    assert.equal(item.feature, 'extensions');
    assert.equal(item.keyName, 'ANNOUNCEMENT_ONLY_EXT_ADD_PROMPT');
    assert.equal(item.brandId, null);
    assert.equal(item.brandSource, 'not-encoded');
    assert.equal(item.brandLookupKey, 'mobileWeb:0a6876c6242797584e9063a58bde9578');
});

test('parseGeneralKey exposes #@# semantic tokens', () => {
    const item = parseGeneralKey(GENERAL_KEYS[1]);
    assert.ok(item);
    assert.equal(item.hasSpecialDelimiter, true);
    assert.equal(item.specialDelimiter, '#@#');
    assert.deepEqual(item.specialTokens, ['AuditTrail', 'Template', 'ChangeByEmbeddedApp']);
    assert.equal(item.feature, 'AuditTrail');
    assert.equal(item.leafName, 'ChangeByEmbeddedApp');
});

test('parseGeneralKey recognizes only explicit brand encodings', () => {
    const encoded = parseGeneralKey(
        'RingCentral.webModule.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.settings.SaveButton__1210__en_US'
    );
    assert.ok(encoded);
    assert.equal(encoded.keyPath, 'settings.SaveButton');
    assert.equal(encoded.brandId, '1210');
    assert.equal(encoded.brandSource, 'terminal-brand-locale-suffix');
    assert.equal(encoded.locale, 'en_US');

    const resolved = parseGeneralKey(GENERAL_KEYS[0], {
        brandResolver: ({ project, hash }) => project === 'jedi' && hash.startsWith('4ac1')
            ? { brandId: '3460', brandName: 'AT&T Office@Hand UB', source: 'test-map' }
            : null,
    });
    assert.equal(resolved.brandId, '3460');
    assert.equal(resolved.brandName, 'AT&T Office@Hand UB');
    assert.equal(resolved.brandSource, 'test-map');
});

test('General parser rejects UNS keys, malformed hashes, and empty path segments', () => {
    assert.equal(parseGeneralKey('RingCentral.uns.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.foo__email_html__1210__en_US'), null);
    assert.equal(parseGeneralKey('RingCentral.jedi.not-a-hash.SomeKey'), null);
    assert.equal(parseGeneralKey('RingCentral.jedi.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.extensions..SomeKey'), null);
});

test('batch parser handles mixed key types, duplicates, and unparsed lines', () => {
    const uns = 'RingCentral.uns.1b165ed92251502e268e4a4708e6a6a0.inventory__email_html__1210__en_US';
    const result = parseKeyBatch([GENERAL_KEYS[0], GENERAL_KEYS[0], GENERAL_KEYS[1], uns, 'not-a-key']);
    assert.equal(result.parsed.length, 3);
    assert.equal(result.general.length, 2);
    assert.equal(result.uns.length, 1);
    assert.equal(result.duplicates, 1);
    assert.deepEqual(result.duplicatesByType, { uns: 0, general: 1 });
    assert.deepEqual(result.unparsed, ['not-a-key']);
});

test('General summary counts projects and useful metadata dimensions', () => {
    const parsed = parseKeyBatch(GENERAL_KEYS).general;
    const summary = summarizeGeneralKeys(parsed);
    assert.equal(summary.total, 3);
    assert.equal(summary.projectCount, 2);
    assert.deepEqual(summary.projects.map(({ project, count }) => ({ project, count })), [
        { project: 'jedi', count: 2 },
        { project: 'mobileWeb', count: 1 },
    ]);
    assert.equal(summary.brandCount, 0);
    assert.deepEqual(summary.brandCoverage, { resolvedKeys: 0, unresolvedKeys: 3 });
    assert.equal(summary.uniqueHashes, 3);
    assert.equal(summary.uniqueFeatures, 3);
    assert.equal(summary.uniqueKeyPaths, 3);
    assert.equal(summary.specialDelimiterKeys, 1);
    assert.deepEqual(summary.pathDepth, {
        min: 1,
        max: 2,
        average: 1.33,
        distribution: [{ depth: 1, count: 2 }, { depth: 2, count: 1 }],
    });
});
