# Troubleshooting: SPIP Article Subtitle Formatting Issues

## Problem Overview

Several SPIP articles in the `kilombo.top` platform have subtitle formatting issues, primarily:
1. **Empty or missing subtitles** (`soustitre` field is blank)
2. **Generic titles without descriptive subtitles** (e.g., "Algo más sobre plandemismo")
3. **Subtitles that look like normal content lines** rather than proper descriptive phrases

## Root Causes Identified

### 1. SPIP Form Field Complexity
- **AJAX-loaded fields**: The `soustitre`, `surtitre`, `chapo`, and `ps` fields are loaded asynchronously in SPIP's edit interface
- **Dual form modes**: SPIP has different field availability in `exec=article` (view mode) vs `exec=article_edit` (edit mode)
- **Conditional field display**: Some fields only appear when certain conditions are met or after user interaction

### 2. Inconsistent Data Entry
- **Manual entry variations**: Different editors use different conventions for subtitles
- **Import/export issues**: Articles imported from other systems may lose subtitle metadata
- **Template inconsistencies**: Some article templates may not include subtitle fields

### 3. Technical Implementation Challenges
- **Selector mismatches**: Field selectors that work in view mode may not work in edit mode
- **Timing issues**: AJAX fields may not be loaded when scripts attempt to access them
- **Form submission variability**: Different SPIP forms have different submit mechanisms

## Solutions Attempted

### ✅ Successful Approaches

#### 1. Simple Subtitle Update Script (`update-spip-subtitle.mjs`)
- **What worked**: Using `exec=article` (view mode) with selector `input[name="soustitre"]`
- **Why it worked**: View mode consistently has the field available (though possibly read-only)
- **Limitations**: Only updates `soustitre` field, may not trigger proper form validation

#### 2. Direct Field Extraction (`extract-spip-article.mjs`)
- **What worked**: Extracting article data from `exec=article` view mode
- **Why it worked**: View mode provides consistent field access without AJAX complexities
- **Use case**: Analysis and data gathering

### ❌ Challenging Approaches

#### 1. Enhanced Field Update Script (`update-article-fields.mjs`)
- **Problem**: Using `exec=article_edit` mode where fields are AJAX-loaded
- **Symptoms**: Selectors don't find fields immediately after page load
- **Root cause**: Fields like `soustitre` may be loaded dynamically after user interaction

#### 2. Batch Processing (`batch-update-subtitles.mjs`)
- **Problem**: Dependent on reliable field access in edit mode
- **Challenge**: Need consistent field detection across all article forms

## Workarounds and Recommendations

### Immediate Fixes (Manual)

1. **For individual articles**: Use the simple script:
   ```bash
   node src/scripts/update-spip-subtitle.mjs <articleId> "<new subtitle>"
   ```

2. **Manual updates via SPIP admin**:
   - Navigate to `https://www.kilombo.top/ecrire/?exec=article&id_article=<ID>`
   - Edit the `soustitre` field directly
   - Save changes

### Automated Solutions (Recommended)

#### Option A: Enhanced Simple Script
Extend the working simple script to handle more fields while staying in view mode:
```javascript
// Current working approach - stay in view mode
const url = `${BASE_URL}/ecrire/?exec=article&id_article=${articleId}`;
```

#### Option B: Hybrid Approach
1. Use view mode to read current values
2. Switch to edit mode only when changes are needed
3. Implement smart waiting for AJAX fields

#### Option C: SPIP API Investigation
Investigate if SPIP provides:
- REST API endpoints for article updates
- Custom plugin hooks for batch operations
- Database-level update scripts

## Technical Details

### Field Selector Analysis

| Field | View Mode (`exec=article`) | Edit Mode (`exec=article_edit`) | Status |
|-------|----------------------------|----------------------------------|--------|
| `soustitre` | `input[name="soustitre"]` ✅ | `input[name="soustitre"]` ❌ | AJAX-loaded |
| `surtitre` | `input[name="surtitre"]` ✅ | `input[name="surtitre"]` ❌ | AJAX-loaded |
| `titre` | `input[name="titre"]` ✅ | `input[name="titre"]` ✅ | Always available |
| `descriptif` | `textarea[name="descriptif"]` ⚠️ | `textarea[name="descriptif"]` ✅ | Conditionally available |

### AJAX Field Loading Pattern
Based on `spip-client.mjs` documentation:
```javascript
// These fields exist in SPIP database but may be in WYSIWYG mode
// They load via AJAX and may not be in initial DOM
surtitre:   { selector: 'input[name="surtitre"]', type: 'text' },   // ⚠️ AJAX
soustitre:  { selector: 'input[name="soustitre"]', type: 'text' },   // ⚠️ AJAX
chapo:      { selector: 'textarea[name="chapo"]', type: 'text' },    // ⚠️ AJAX
ps:         { selector: 'textarea[name="ps"]', type: 'text' },       // ⚠️ AJAX
```

## Prevention Strategies

### 1. Validation at Creation
- Enhance `article-validator.mjs` to flag articles with poor subtitle formatting
- Implement subtitle quality checks (length, descriptiveness, etc.)

### 2. Template Standardization
- Create standardized article templates with predefined subtitle patterns
- Implement subtitle generation based on content analysis

### 3. Editor Guidelines
- Document subtitle best practices in `docs/ARTICLE-DESIGN.md`
- Provide examples of good vs. bad subtitles

### 4. Regular Audits
- Schedule periodic subtitle quality checks
- Implement automated detection of formatting issues

## Script Inventory

### Working Scripts
- `update-spip-subtitle.mjs` - Simple subtitle updates (view mode)
- `extract-spip-article.mjs` - Article data extraction
- `analyze-subtitle-issues.mjs` - Subtitle quality analysis

### Scripts Needing Adjustment
- `update-article-fields.mjs` - Needs AJAX field handling
- `batch-update-subtitles.mjs` - Depends on reliable field access

### Analysis Scripts
- `check-subtitle-details.mjs` - Detailed subtitle analysis
- `fix-spip-subtitles.mjs` - Batch fixing (currently timing out)

## Next Steps

### Short Term (1-2 weeks)
1. Document current working solutions
2. Train team on manual update procedures
3. Implement basic validation rules

### Medium Term (1 month)
1. Fix AJAX field loading in update scripts
2. Implement batch processing for common issues
3. Create subtitle quality dashboard

### Long Term (3 months)
1. Investigate SPIP API alternatives
2. Implement machine learning for subtitle suggestions
3. Create comprehensive editorial workflow

## Emergency Procedures

### If subtitle updates fail:
1. **First**: Try manual update via SPIP admin
2. **Second**: Use `update-spip-subtitle.mjs` with view mode
3. **Third**: Document the issue and proceed with manual fix

### If batch processing is needed:
1. **First**: Extract all articles with `extract-spip-article.mjs`
2. **Second**: Analyze issues offline
3. **Third**: Apply fixes individually or in small batches

---

*Last Updated: 2026-09-12*
*Documentation Status: Work in Progress*
*Primary Contact: Kiro Development Team*