# SK Desk requested updates

## Page components

- `page-components/CashBankPage.tsx` — complete replacement for Cash & Bank.
- `page-components/BudgetPage.tsx` — Budget preview pagination/panning updates and form ID card.
- `page-components/GovernancePage.tsx` — itemized Request Letter signatories, safer text wrapping/page cuts, and form ID cards.
- `page-components/ProcurementPage.tsx` — safer preview pagination/panning and form ID card.
- `page-components/DisbursementsPage.tsx` — safer preview pagination/panning and form ID card.
- `page-components/LoginPage.tsx` — split login page with Barangay Hall image under the blue theme.

Copy each page component into the same folder where its existing counterpart currently lives. Keep the original filename and import structure. Do not move these modules to a new folder just because they are grouped in this ZIP.

## Shared files

- `hooks/useDragToPan.ts` — shared pointer-drag handler imported by the document modules. Put it in the `src/hooks/` location resolved by the existing `../../hooks/useDragToPan` imports (or adjust the imports if your project uses a different structure).
- `public/brgy-building.jpg` — copy this into the project's `public/` directory. The login component refers to it as `/brgy-building.jpg`.

## Notes

- Request Letter signatories are saved in the Governance payload as an array. The legacy single-signatory columns still receive the first signatory for backward compatibility.
- Cash & Bank paper size/orientation selectors default to A4 landscape for RCRD, RCB and Check Logbook, and A4 portrait for Bank Reconciliation. The selected values affect preview and print. They are not persisted in Supabase because the supplied Cash & Bank schema does not include corresponding paper-size/orientation columns.
- Check Logbook retains Name of Payee and Authorized Representative as transaction fields because those are columns in the reference form. Fixed officer names/signatories are displayed as text rather than editable name inputs.
- Preview pagination uses whitespace-aware page slicing when a safe band is available; otherwise it falls back to the normal page boundary.
