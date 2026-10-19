// Read-only check of the Zoho CRM Leads configuration. Never creates or edits records.
import {
  fetchLeadFieldMetadata,
  getZohoAccessToken,
  getZohoConfig,
  LEAD_SOURCE_FREE,
  LEAD_SOURCE_PAID,
  ZohoError,
} from "../src/lib/zoho";

const REQUIRED_FIELDS = [
  "Last_Name",
  "First_Name",
  "Email",
  "Mobile",
  "Company",
  "Website",
  "Description",
  "Lead_Source",
];

async function main(): Promise<boolean> {
  for (const file of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Optional file.
    }
  }

  try {
    getZohoConfig();
  } catch (error) {
    console.error(
      `Zoho is not configured (${error instanceof ZohoError ? error.code : "UNKNOWN"}). ` +
        "Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN and ZOHO_ACCOUNTS_URL."
    );
    return false;
  }

  const { apiDomain } = await getZohoAccessToken();
  console.log(`Authenticated. API domain for this account: ${apiDomain}\n`);

  const fields = await fetchLeadFieldMetadata();
  let ok = true;
  for (const apiName of REQUIRED_FIELDS) {
    const field = fields.find((candidate) => candidate.apiName === apiName);
    if (!field) {
      ok = false;
      console.log(`MISSING  Leads field ${apiName}`);
      continue;
    }
    const length = field.length ? `, max length ${field.length}` : "";
    console.log(`OK       Leads field ${apiName} (${field.dataType ?? "unknown type"}${length})`);
  }

  const picklist = fields.find((field) => field.apiName === "Lead_Source")?.picklist ?? [];
  console.log(`\nLead_Source picklist: ${picklist.map((option) => option.display).join(", ") || "(none)"}`);
  for (const required of [LEAD_SOURCE_FREE, LEAD_SOURCE_PAID]) {
    const found = picklist.some((option) => option.display === required || option.actual === required);
    if (!found) ok = false;
    console.log(`${found ? "OK     " : "MISSING"}  Lead_Source value "${required}"`);
  }

  console.log(ok ? "\nZoho CRM configuration looks correct." : "\nFix the MISSING items above in Zoho CRM.");
  return ok;
}

main()
  .then((ok) => {
    process.exitCode = ok ? 0 : 1;
  })
  .catch((error: unknown) => {
    console.error(`Verification failed: ${error instanceof ZohoError ? error.code : "UNEXPECTED_ERROR"}`);
    process.exitCode = 1;
  });
