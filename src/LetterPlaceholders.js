/**
 * Placeholder resolution for letter templates. Confirmed live on
 * 2026-08-19 that a template's actual body text does NOT reliably match
 * what its filename implies -- e.g. one template's filename says
 * "<<Full Name>>" but its body actually says "<<First Name>>", uses
 * "<<Designation>>" (not "<<Position>>"), and mixes casing
 * ("<<Confirmation Date>>" vs "<<confirmation date>>") within the SAME
 * document. So every mapping here was confirmed directly with Chris
 * against the real column meanings, not inferred from filenames:
 *   Full Name / First Name  -> Mastersheet column C (FULL NAME)
 *   Entity                  -> column K (OFFICIAL COMPANY)
 *   Position / Designation  -> column N (POSITION)
 *   Commencement/Joining/Join Date -> column G
 *   LWD / Last Working Day / Official Last Day -> column I
 *   Confirmation Date       -> column H
 *   NRIC / unmasked NRIC    -> column Q (IC ( NRIC, FIN))
 *
 * A canonical field only ever has ONE correct value per employee, so every
 * occurrence of any of its aliases (any casing) gets replaced with that one
 * value in a single pass -- see applyPlaceholderReplacements_(). Anything
 * NOT in this map is treated as transaction-specific (e.g. "amount",
 * "purpose", "reason" -- values that can legitimately differ between two
 * occurrences in the same letter, like an old-vs-new salary figure) and is
 * surfaced as a manual-input field PER OCCURRENCE instead -- confirmed with
 * Chris that per-occurrence input (not one shared value) is what he wants
 * for exactly this reason.
 */

var PLACEHOLDER_FIELD_ALIASES = [
  { contextKey: 'fullName', aliases: ['full name', 'first name'] },
  { contextKey: 'officialCompany', aliases: ['entity'] },
  { contextKey: 'position', aliases: ['position', 'designation'] },
  { contextKey: 'commencementDate', aliases: ['commencement date', 'joining date', 'join date'] },
  { contextKey: 'lastWorkingDay', aliases: ['lwd', 'last working day', 'official last day'] },
  { contextKey: 'confirmationDate', aliases: ['confirmation date'] },
  { contextKey: 'nric', aliases: ['nric', 'unmasked nric'] },
];

/** Escapes a string for safe use inside a `new RegExp(...)` pattern. */
function escapeRegExp_(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every <<...>> token's inner text as it literally appears in `text`, trimmed, in order, NOT deduped. */
function extractPlaceholderTokens_(text) {
  var matches = String(text || '').match(/<<[^<>]+>>/g) || [];
  return matches.map(function (m) { return m.slice(2, -2).trim(); });
}

function matchesFieldAlias_(rawToken, aliases) {
  return aliases.indexOf(rawToken.toLowerCase()) !== -1;
}

/**
 * Splits a template's raw <<...>> tokens (in document order) into:
 *   resolvedFields: [{contextKey, aliases}] -- one entry per canonical
 *     field actually present, deduped regardless of how many times or
 *     under which alias/casing it appears.
 *   unresolvedTokens: [{token, occurrenceIndex, occurrenceCount}] -- one
 *     entry PER OCCURRENCE (not deduped) of every token that isn't a known
 *     field, grouped case-insensitively for occurrence counting.
 */
function classifyPlaceholderTokens_(rawTokensInOrder) {
  var resolvedFields = [];
  var resolvedContextKeysSeen = {};
  var unresolvedCounts = {};
  var unresolvedTokens = [];

  rawTokensInOrder.forEach(function (rawToken) {
    var matchedField = null;
    for (var i = 0; i < PLACEHOLDER_FIELD_ALIASES.length; i++) {
      if (matchesFieldAlias_(rawToken, PLACEHOLDER_FIELD_ALIASES[i].aliases)) {
        matchedField = PLACEHOLDER_FIELD_ALIASES[i];
        break;
      }
    }
    if (matchedField) {
      if (!resolvedContextKeysSeen[matchedField.contextKey]) {
        resolvedContextKeysSeen[matchedField.contextKey] = true;
        resolvedFields.push({ contextKey: matchedField.contextKey, aliases: matchedField.aliases });
      }
      return;
    }
    var normalized = rawToken.toLowerCase();
    var occurrenceIndex = unresolvedCounts[normalized] || 0;
    unresolvedCounts[normalized] = occurrenceIndex + 1;
    unresolvedTokens.push({ token: rawToken, occurrenceIndex: occurrenceIndex });
  });

  unresolvedTokens.forEach(function (entry) {
    entry.occurrenceCount = unresolvedCounts[entry.token.toLowerCase()];
  });

  return { resolvedFields: resolvedFields, unresolvedTokens: unresolvedTokens };
}

/** A value made safe to pass as Body.replaceText()'s replacement argument (which treats \ and $ specially). */
function escapeReplacementValue_(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/\$/g, '\\$');
}

/**
 * Applies every replacement to a live (already-copied) template Doc's body.
 * Resolved fields are replaced globally in one regex pass per field
 * (covers every alias and casing at once -- safe, since the field has only
 * one correct value throughout the letter). Unresolved tokens are replaced
 * ONE OCCURRENCE AT A TIME via findText(), walking forward from the
 * previous match -- never a global replace for these, since two
 * occurrences of the same unresolved token (e.g. two "<<amount>>"s) may
 * need genuinely different values.
 *
 * `unresolvedValues`: [{token, occurrenceIndex, value}] -- exactly what
 * LetterSidebar.html collects from its per-occurrence input fields.
 */
function applyPlaceholderReplacements_(body, resolvedFields, employeeContext, unresolvedValues) {
  resolvedFields.forEach(function (field) {
    var aliasPattern = field.aliases.map(escapeRegExp_).join('|');
    var pattern = '<<\\s*(?:' + aliasPattern + ')\\s*>>';
    body.replaceText(pattern, escapeReplacementValue_(employeeContext[field.contextKey]));
  });

  (unresolvedValues || []).forEach(function (entry) {
    var pattern = escapeRegExp_('<<' + entry.token + '>>');
    var found = null;
    for (var i = 0; i <= entry.occurrenceIndex; i++) {
      found = body.findText(pattern, found);
      if (!found) break;
    }
    if (!found) return; // token no longer at the expected position -- skip rather than throw
    var textElement = found.getElement().asText();
    var start = found.getStartOffset();
    var end = found.getEndOffsetInclusive();
    textElement.deleteText(start, end);
    textElement.insertText(start, String(entry.value || ''));
  });
}

/** Same resolved-field substitution, applied to a plain string (the template's own file name) rather than a Doc body. */
function applyPlaceholderReplacementsToText_(text, resolvedFields, employeeContext) {
  var result = String(text || '');
  resolvedFields.forEach(function (field) {
    var aliasPattern = field.aliases.map(escapeRegExp_).join('|');
    var pattern = new RegExp('<<\\s*(?:' + aliasPattern + ')\\s*>>', 'gi');
    result = result.replace(pattern, String(employeeContext[field.contextKey] || ''));
  });
  return result;
}
