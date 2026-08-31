'use strict';

// Pure key parsing helpers shared by the browser dashboard and Node tests.
// The UMD wrapper keeps the app fully offline: CommonJS receives exports while
// the browser gets window.KeyMetadataParser from the same bundled file.
(function exposeKeyMetadataParser(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.KeyMetadataParser = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createKeyMetadataParser() {
    const GENERAL_HASH_RE = /^[a-fA-F0-9]{32}$/;
    const UNS_BRAND_ID_RE = /^\d+(?:\.[A-Za-z0-9_]+)?$/;
    const UNS_HEAD_RE = /^([A-Za-z][A-Za-z0-9_]*)\.uns\.(.+)$/;
    const GENERAL_KEY_RE = /^([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_-]*)\.([a-fA-F0-9]{32})\.([^\s.]+(?:\.[^\s.]+)*)$/;
    const SPECIAL_DELIMITER = '#@#';
    // Tranzor MR Pipeline TUs: <baseKey>:::seg:::<uid> (canonical) or ::seg:::<uid>.
    const UNS_SEG_SUFFIX_RE = /(:::seg:::|::seg:::)([A-Za-z0-9][A-Za-z0-9._-]*)$/;

    function cleanKeyLine(line) {
        let cleaned = String(line || '').trim();
        if (!cleaned) return '';
        cleaned = cleaned.replace(/^[\s\-*•‣◦]+/, '').trim();
        // Spreadsheet / frequency pastes often append a count column
        // (`key<tab>7` or `"key"  7`). Strip it before quote cleanup so a
        // trailing count cannot pin a closing quote in place.
        cleaned = cleaned.replace(/[\t ]+\d+\s*$/, '').trim();
        cleaned = cleaned.replace(/^["'`]+/, '').replace(/["'`,]+$/, '').trim();
        return cleaned;
    }

    function tidLeafOf(tid) {
        const segments = String(tid || '').split('.');
        return segments[segments.length - 1] || tid;
    }

    // Tranzor names may prefix the real template id with a storage path:
    //   new.<tid>              → uns-app/newTemplateStorage/<tid>
    //   new.partials.<tid>     → uns-app/newTemplateStorage/_partials/<tid>
    //   partials.<tid>         → uns-app/templateStorage/_partials/<tid>
    // Bare Tranzor names live in uns-app/templateStorage/<tid>.
    // Legacy Opus names have no such prefix (storage is recovered from hash).
    function splitUnsLocation(namePath) {
        const segments = String(namePath || '').split('.').filter(Boolean);
        let storageFolder = null;
        let isPartial = null;
        let i = 0;
        if (segments[0] === 'new' && segments.length > 1) {
            storageFolder = 'newTemplateStorage';
            i = 1;
        }
        if (segments[i] === 'partials' && segments.length > i + 1) {
            storageFolder = storageFolder || 'templateStorage';
            isPartial = true;
            i += 1;
        } else if (storageFolder === 'newTemplateStorage') {
            isPartial = false;
        }
        const tid = segments.slice(i).join('.');
        return {
            tid: tid || namePath,
            pathPrefix: segments.slice(0, i).join('.'),
            storageFolder,
            isPartial,
        };
    }

    // Tranzor MR Pipeline TUs append :::seg:::<uid> (canonical) or ::seg:::<uid>
    // to an otherwise valid UNS key. Peel it so brand / locale still validate.
    function splitUnsSegmentSuffix(key) {
        const value = String(key || '');
        const match = value.match(UNS_SEG_SUFFIX_RE);
        if (!match) return { baseKey: value, segmentId: null, segmentMarker: null };
        return {
            baseKey: value.slice(0, match.index),
            segmentId: match[2],
            segmentMarker: match[1],
        };
    }

    // Steal a leading hex path-hash from `<hash>.<name>`. Legacy Opus keys
    // always inject one; Tranzor names may contain dotted path segments
    // (`new.partials.footerLogo…`) that must not be mistaken for a hash.
    function splitUnsHashPrefix(tid, minHashLength) {
        const match = String(tid || '').match(/^([a-fA-F0-9]+)\.(.+)$/);
        if (!match) return { hash: null, tid };
        if (match[1].length < minHashLength) return { hash: null, tid };
        return { hash: match[1], tid: match[2] };
    }

    function parseUnsKey(line) {
        const cleaned = cleanKeyLine(line);
        if (!cleaned) return null;

        // MR Pipeline TUs append :::seg:::<uid> to an otherwise valid UNS key.
        // Peel that suffix first so brandId / locale still match UNS_BRAND_ID_RE.
        const { baseKey, segmentId, segmentMarker } = splitUnsSegmentSuffix(cleaned);
        if (!baseKey) return null;

        const head = baseKey.match(UNS_HEAD_RE);
        if (!head) return null;
        const [, namespace, rest] = head;
        const parts = rest.split('__');
        // Legacy (Opus / L10n Portal):
        //   <ns>.uns.<hash>.<name>__<type>__<brandId>__<locale>
        // Tranzor (current):
        //   <ns>.uns.<name>__<type>__<brandId>
        //   <name> may itself contain dotted segments.
        // Tranzor MR Pipeline TUs (same as Tranzor / legacy, plus suffix):
        //   <baseKey>:::seg:::<uid>
        if (parts.length !== 3 && parts.length !== 4) return null;

        const hasLocale = parts.length === 4;
        const kind = parts[1];
        const brandId = parts[2];
        const locale = hasLocale ? parts[3] : null;
        if (!parts[0] || !kind || !UNS_BRAND_ID_RE.test(brandId)) return null;
        if (hasLocale && !locale) return null;

        // 4-segment keys keep the previous "any hex run + dot" hash rule.
        // 3-segment keys only treat a 32-char hex prefix as a hash so that
        // names like `new.partials.footerLogoTosAndCopyright` stay intact.
        const { hash, tid: namePath } = splitUnsHashPrefix(parts[0], hasLocale ? 1 : 32);
        if (!namePath) return null;

        const loc = splitUnsLocation(namePath);
        const isTranzor = !hash && !hasLocale;
        let storageFolder = loc.storageFolder;
        let isPartial = loc.isPartial;
        if (isTranzor) {
            if (storageFolder == null) storageFolder = 'templateStorage';
            if (isPartial == null) isPartial = false;
        }

        return {
            keyType: 'uns',
            format: hash || hasLocale ? 'legacy' : 'tranzor',
            raw: cleaned,
            baseKey,
            segmentId,
            segmentMarker,
            namespace,
            prefix: namespace + '.uns',
            hash,
            namePath,
            pathPrefix: loc.pathPrefix || '',
            storageFolder,
            isPartial,
            tid: loc.tid,
            tidLeaf: tidLeafOf(loc.tid),
            kind,
            brandId,
            locale,
        };
    }

    // General keys do not have one universal brand slot. We only claim a brand
    // when the key uses an explicit, anchored convention. Everything else stays
    // null and exposes brandLookupKey so callers can join against a project/hash
    // resource map without guessing from ordinary path segments.
    function extractEncodedBrand(rawKeyPath) {
        const unsStyleSuffix = rawKeyPath.match(/__(\d+(?:\.[A-Za-z0-9_]+)?)__([A-Za-z]{2,3}(?:[_-][A-Za-z0-9]{2,8})+)$/);
        if (unsStyleSuffix) {
            return {
                brandId: unsStyleSuffix[1],
                brandSource: 'terminal-brand-locale-suffix',
                locale: unsStyleSuffix[2],
                keyPath: rawKeyPath.slice(0, unsStyleSuffix.index),
            };
        }

        const namedSuffix = rawKeyPath.match(/__(?:brand|brandId)[=:]([A-Za-z0-9][A-Za-z0-9_.-]*)$/i);
        if (namedSuffix) {
            return {
                brandId: namedSuffix[1],
                brandSource: 'named-brand-suffix',
                locale: null,
                keyPath: rawKeyPath.slice(0, namedSuffix.index),
            };
        }

        const pathMarker = rawKeyPath.match(/(?:^|\.)(?:brand|brandId)\.([A-Za-z0-9_-]+)(?:\.|$)/i);
        if (pathMarker) {
            return {
                brandId: pathMarker[1],
                brandSource: 'brand-path-segment',
                locale: null,
                keyPath: rawKeyPath,
            };
        }
        return null;
    }

    function normalizeResolvedBrand(value) {
        if (typeof value === 'string' && value.trim()) {
            return { brandId: value.trim(), brandSource: 'resolver', brandName: null };
        }
        if (!value || typeof value !== 'object') return null;
        const id = String(value.brandId || value.id || '').trim();
        if (!id) return null;
        return {
            brandId: id,
            brandSource: value.source || 'resolver',
            brandName: value.brandName || value.name || null,
        };
    }

    function cleanSpecialToken(value) {
        return String(value || '').replace(/^[_*\s]+|[_*\s]+$/g, '');
    }

    function parseGeneralKey(line, options) {
        const cleaned = cleanKeyLine(line);
        if (!cleaned) return null;

        const match = cleaned.match(GENERAL_KEY_RE);
        if (!match) return null;
        const [, namespace, project, hash, rawKeyPath] = match;
        if (project.toLowerCase() === 'uns' || !GENERAL_HASH_RE.test(hash)) return null;

        const encodedBrand = extractEncodedBrand(rawKeyPath);
        const keyPath = (encodedBrand && encodedBrand.keyPath) || rawKeyPath;
        if (!keyPath) return null;

        const pathSegments = keyPath.split('.');
        const keyName = pathSegments[pathSegments.length - 1];
        const hasSpecialDelimiter = keyName.includes(SPECIAL_DELIMITER);
        const specialTokens = hasSpecialDelimiter
            ? keyName.split(SPECIAL_DELIMITER).map(cleanSpecialToken).filter(Boolean)
            : [];
        const feature = pathSegments.length > 1
            ? pathSegments[0]
            : (specialTokens[0] || keyName);
        const leafName = specialTokens.length > 1
            ? specialTokens[specialTokens.length - 1]
            : keyName;

        let brand = encodedBrand ? {
            brandId: encodedBrand.brandId,
            brandSource: encodedBrand.brandSource,
            brandName: null,
        } : null;

        const resolver = options && options.brandResolver;
        if (!brand && typeof resolver === 'function') {
            // Resolver failures must not turn an otherwise valid key into an
            // unparsed line. The UI can retry enrichment after loading a map.
            try {
                brand = normalizeResolvedBrand(resolver({
                    namespace,
                    project,
                    hash,
                    keyPath,
                    raw: cleaned,
                }));
            } catch {}
        }

        return {
            keyType: 'general',
            raw: cleaned,
            namespace,
            project,
            hash,
            rawKeyPath,
            keyPath,
            pathSegments,
            pathDepth: pathSegments.length,
            feature,
            keyName,
            leafName,
            hasSpecialDelimiter,
            specialDelimiter: hasSpecialDelimiter ? SPECIAL_DELIMITER : null,
            specialTokens,
            specialTokenCount: specialTokens.length,
            brandId: brand ? brand.brandId : null,
            brandName: brand ? brand.brandName : null,
            brandSource: brand ? brand.brandSource : 'not-encoded',
            brandLookupKey: `${project}:${hash.toLowerCase()}`,
            locale: encodedBrand ? encodedBrand.locale : null,
        };
    }

    function parseKeyBatch(input, options) {
        const lines = Array.isArray(input) ? input : String(input || '').split(/\r?\n/);
        const parsed = [];
        const uns = [];
        const general = [];
        const unparsed = [];
        const seen = new Set();
        const duplicatesByType = { uns: 0, general: 0 };

        for (const raw of lines) {
            if (!String(raw || '').trim()) continue;
            const item = parseUnsKey(raw) || parseGeneralKey(raw, options);
            if (!item) {
                unparsed.push(raw);
                continue;
            }
            const dedupKey = item.raw;
            if (seen.has(dedupKey)) {
                duplicatesByType[item.keyType] += 1;
                continue;
            }
            seen.add(dedupKey);
            parsed.push(item);
            if (item.keyType === 'uns') uns.push(item);
            else general.push(item);
        }

        return {
            parsed,
            uns,
            general,
            unparsed,
            duplicates: duplicatesByType.uns + duplicatesByType.general,
            duplicatesByType,
        };
    }

    function sortedCountRows(map, keyName) {
        return [...map.entries()]
            .map(([name, count]) => ({ [keyName]: name, count }))
            .sort((a, b) => b.count - a.count || String(a[keyName]).localeCompare(String(b[keyName])));
    }

    function summarizeGeneralKeys(items) {
        const generalItems = (items || []).filter(item => item && item.keyType === 'general');
        const namespaceCounts = new Map();
        const projectData = new Map();
        const brandData = new Map();
        const hashData = new Map();
        const featureCounts = new Map();
        const keyPathCounts = new Map();
        const depthCounts = new Map();
        let specialDelimiterKeys = 0;
        let resolvedBrandKeys = 0;

        for (const item of generalItems) {
            namespaceCounts.set(item.namespace, (namespaceCounts.get(item.namespace) || 0) + 1);
            featureCounts.set(item.feature, (featureCounts.get(item.feature) || 0) + 1);
            keyPathCounts.set(item.keyPath, (keyPathCounts.get(item.keyPath) || 0) + 1);
            depthCounts.set(item.pathDepth, (depthCounts.get(item.pathDepth) || 0) + 1);
            if (item.hasSpecialDelimiter) specialDelimiterKeys += 1;

            if (!projectData.has(item.project)) {
                projectData.set(item.project, {
                    count: 0,
                    hashes: new Set(),
                    features: new Set(),
                    brands: new Set(),
                    resolvedBrandKeys: 0,
                });
            }
            const project = projectData.get(item.project);
            project.count += 1;
            project.hashes.add(item.hash.toLowerCase());
            project.features.add(item.feature);
            if (item.brandId) {
                project.brands.add(item.brandId);
                project.resolvedBrandKeys += 1;
            }

            const normalizedHash = item.hash.toLowerCase();
            if (!hashData.has(normalizedHash)) hashData.set(normalizedHash, { count: 0, projects: new Set() });
            const hash = hashData.get(normalizedHash);
            hash.count += 1;
            hash.projects.add(item.project);

            if (item.brandId) {
                resolvedBrandKeys += 1;
                if (!brandData.has(item.brandId)) {
                    brandData.set(item.brandId, { count: 0, sources: new Set(), name: item.brandName || null });
                }
                const brand = brandData.get(item.brandId);
                brand.count += 1;
                brand.sources.add(item.brandSource);
                if (!brand.name && item.brandName) brand.name = item.brandName;
            }
        }

        const projects = [...projectData.entries()].map(([project, data]) => ({
            project,
            count: data.count,
            uniqueHashes: data.hashes.size,
            uniqueFeatures: data.features.size,
            brands: data.brands.size,
            unresolvedBrandKeys: data.count - data.resolvedBrandKeys,
        })).sort((a, b) => b.count - a.count || a.project.localeCompare(b.project));

        const brands = [...brandData.entries()].map(([brandId, data]) => ({
            brandId,
            brandName: data.name,
            count: data.count,
            sources: [...data.sources].sort(),
        })).sort((a, b) => b.count - a.count || a.brandId.localeCompare(b.brandId));

        const hashes = [...hashData.entries()].map(([hash, data]) => ({
            hash,
            count: data.count,
            projects: [...data.projects].sort(),
        })).sort((a, b) => b.count - a.count || a.hash.localeCompare(b.hash));

        const depths = generalItems.map(item => item.pathDepth);
        const depthTotal = depths.reduce((sum, depth) => sum + depth, 0);
        return {
            total: generalItems.length,
            projectCount: projects.length,
            projects,
            brandCount: brands.length,
            brands,
            brandCoverage: {
                resolvedKeys: resolvedBrandKeys,
                unresolvedKeys: generalItems.length - resolvedBrandKeys,
            },
            uniqueHashes: hashes.length,
            hashes,
            uniqueFeatures: featureCounts.size,
            features: sortedCountRows(featureCounts, 'feature'),
            uniqueKeyPaths: keyPathCounts.size,
            keyPaths: sortedCountRows(keyPathCounts, 'keyPath'),
            namespaces: sortedCountRows(namespaceCounts, 'namespace'),
            specialDelimiterKeys,
            plainKeys: generalItems.length - specialDelimiterKeys,
            pathDepth: {
                min: depths.length ? Math.min(...depths) : 0,
                max: depths.length ? Math.max(...depths) : 0,
                average: depths.length ? Number((depthTotal / depths.length).toFixed(2)) : 0,
                distribution: sortedCountRows(depthCounts, 'depth'),
            },
        };
    }

    return {
        GENERAL_HASH_RE,
        GENERAL_KEY_RE,
        SPECIAL_DELIMITER,
        UNS_BRAND_ID_RE,
        UNS_HEAD_RE,
        UNS_SEG_SUFFIX_RE,
        cleanKeyLine,
        splitUnsLocation,
        splitUnsSegmentSuffix,
        parseUnsKey,
        parseGeneralKey,
        parseKeyBatch,
        summarizeGeneralKeys,
    };
}));
