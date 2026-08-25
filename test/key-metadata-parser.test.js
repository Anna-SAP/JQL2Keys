'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    parseUnsKey,
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

test('parseUnsKey extracts legacy Opus keys with hash and locale', () => {
    const item = parseUnsKey(
        'RingCentral.uns.37568911e605fa5474970da9ee5b4b7b.airLeadDigest__email_html__1210__en_US'
    );
    assert.ok(item);
    assert.equal(item.keyType, 'uns');
    assert.equal(item.format, 'legacy');
    assert.equal(item.namespace, 'RingCentral');
    assert.equal(item.prefix, 'RingCentral.uns');
    assert.equal(item.hash, '37568911e605fa5474970da9ee5b4b7b');
    assert.equal(item.tid, 'airLeadDigest');
    assert.equal(item.tidLeaf, 'airLeadDigest');
    assert.equal(item.kind, 'email_html');
    assert.equal(item.brandId, '1210');
    assert.equal(item.locale, 'en_US');
});

test('parseUnsKey extracts Tranzor keys without hash or locale', () => {
    const item = parseUnsKey('common.uns.meetingRecordingAvailable__email_subject__2210');
    assert.ok(item);
    assert.equal(item.format, 'tranzor');
    assert.equal(item.namespace, 'common');
    assert.equal(item.prefix, 'common.uns');
    assert.equal(item.hash, null);
    assert.equal(item.tid, 'meetingRecordingAvailable');
    assert.equal(item.tidLeaf, 'meetingRecordingAvailable');
    assert.equal(item.kind, 'email_subject');
    assert.equal(item.brandId, '2210');
    assert.equal(item.locale, null);
});

test('parseUnsKey keeps dotted name segments on Tranzor keys', () => {
    const item = parseUnsKey(
        'common.uns.new.partials.footerLogoTosAndCopyright__email_html__1210'
    );
    assert.ok(item);
    assert.equal(item.format, 'tranzor');
    assert.equal(item.hash, null);
    assert.equal(item.tid, 'new.partials.footerLogoTosAndCopyright');
    assert.equal(item.tidLeaf, 'footerLogoTosAndCopyright');
    assert.equal(item.kind, 'email_html');
    assert.equal(item.brandId, '1210');
    assert.equal(item.locale, null);
});

test('parseUnsKey strips a trailing frequency count column', () => {
    const item = parseUnsKey('common.uns.bridgeDelegateGranted__email_html__1210  7');
    assert.ok(item);
    assert.equal(item.format, 'tranzor');
    assert.equal(item.tid, 'bridgeDelegateGranted');
    assert.equal(item.brandId, '1210');
    assert.equal(item.raw, 'common.uns.bridgeDelegateGranted__email_html__1210');

    const quoted = parseUnsKey('"common.uns.bridgeDelegateGranted__email_subject__1210"\t1');
    assert.ok(quoted);
    assert.equal(quoted.kind, 'email_subject');
    assert.equal(quoted.raw, 'common.uns.bridgeDelegateGranted__email_subject__1210');
});

test('parseUnsKey still accepts a 32-char hash when the locale suffix is omitted', () => {
    const item = parseUnsKey(
        'RingCentral.uns.1b165ed92251502e268e4a4708e6a6a0.inventory__email_html__1210'
    );
    assert.ok(item);
    assert.equal(item.format, 'legacy');
    assert.equal(item.hash, '1b165ed92251502e268e4a4708e6a6a0');
    assert.equal(item.tid, 'inventory');
    assert.equal(item.locale, null);
});

test('parseUnsKey rejects malformed UNS lines', () => {
    assert.equal(parseUnsKey('common.uns.meetingRecordingAvailable__email_subject'), null);
    assert.equal(parseUnsKey('common.uns.meetingRecordingAvailable'), null);
    assert.equal(parseUnsKey('RingCentral.jedi.4ac1be6d554451a0415e6f74fc494588.DispositionCodeRequired'), null);
    assert.equal(parseUnsKey('not-a-key'), null);
});

test('General parser rejects UNS keys, malformed hashes, and empty path segments', () => {
    assert.equal(parseGeneralKey('RingCentral.uns.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.foo__email_html__1210__en_US'), null);
    assert.equal(parseGeneralKey('common.uns.meetingRecordingAvailable__email_subject__2210'), null);
    assert.equal(parseGeneralKey('RingCentral.jedi.not-a-hash.SomeKey'), null);
    assert.equal(parseGeneralKey('RingCentral.jedi.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.extensions..SomeKey'), null);
});

test('batch parser handles mixed key types, duplicates, and unparsed lines', () => {
    const unsLegacy = 'RingCentral.uns.1b165ed92251502e268e4a4708e6a6a0.inventory__email_html__1210__en_US';
    const unsTranzor = 'common.uns.meetingRecordingAvailable__email_subject__2210';
    const result = parseKeyBatch([
        GENERAL_KEYS[0], GENERAL_KEYS[0], GENERAL_KEYS[1],
        unsLegacy, unsTranzor, 'not-a-key',
    ]);
    assert.equal(result.parsed.length, 4);
    assert.equal(result.general.length, 2);
    assert.equal(result.uns.length, 2);
    assert.equal(result.duplicates, 1);
    assert.deepEqual(result.duplicatesByType, { uns: 0, general: 1 });
    assert.deepEqual(result.unparsed, ['not-a-key']);
    assert.equal(result.uns[0].format, 'legacy');
    assert.equal(result.uns[1].format, 'tranzor');
});

test('batch parser de-duplicates a Tranzor key pasted with a trailing count', () => {
    const result = parseKeyBatch([
        'common.uns.bridgeDelegateGranted__email_html__1210  7',
        'common.uns.bridgeDelegateGranted__email_html__1210',
    ]);
    assert.equal(result.parsed.length, 1);
    assert.equal(result.duplicates, 1);
    assert.deepEqual(result.duplicatesByType, { uns: 1, general: 0 });
});

test('batch parser recognizes the screenshot-style common.uns paste', () => {
    const paste = [
        'common.uns.bridgeDelegateGranted__email_html__1210  7',
        'common.uns.bridgeDelegateGranted__email_html__2110  5',
        'common.uns.bridgeDelegateGranted__email_html__2210  5',
        'common.uns.bridgeDelegateGranted__email_html__6010  5',
        'common.uns.bridgeDelegateGranted__email_html__9010  5',
        'common.uns.bridgeDelegateGranted__email_subject__1210  1',
        'common.uns.bridgeDelegateGranted__email_subject__2110  1',
        'common.uns.bridgeDelegateGranted__email_subject__2210  1',
        'common.uns.bridgeDelegateGranted__email_subject__6010  1',
        'common.uns.bridgeDelegateGranted__email_subject__9010  1',
    ].join('\n');
    const result = parseKeyBatch(paste);
    assert.equal(result.parsed.length, 10);
    assert.equal(result.uns.length, 10);
    assert.equal(result.unparsed.length, 0);
    assert.ok(result.uns.every(item => item.format === 'tranzor'));
    assert.deepEqual([...new Set(result.uns.map(item => item.tid))], ['bridgeDelegateGranted']);
    assert.deepEqual([...new Set(result.uns.map(item => item.brandId))].sort(), [
        '1210', '2110', '2210', '6010', '9010',
    ]);
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
