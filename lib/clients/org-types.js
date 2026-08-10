"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ORG_TYPES = void 0;
// Single source for the client/prospect org-type options. Drives the form dropdowns
// (both the full Add Client/Prospect form and the lightweight Add-prospect form) and
// their `.replace(/_/g, " ")` display labels. Add new applicant types here so the two
// forms never drift. Stored verbatim on clients.org_type (free text; the matcher reads
// it as a string).
exports.ORG_TYPES = [
    "nonprofit",
    "local_government",
    "state_government",
    "small_business",
    "higher_education",
];
