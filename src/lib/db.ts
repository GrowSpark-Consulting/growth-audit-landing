import { MongoClient, Db } from "mongodb";

declare global {
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

const dbName = process.env.MONGODB_DB_NAME || "growth_audit";

let cachedClientPromise: Promise<MongoClient> | null = null;

/**
 * Returns true if the MONGODB_URI environment variable is populated.
 */
export function isMongoConfigured(): boolean {
  return Boolean(process.env.MONGODB_URI && process.env.MONGODB_URI.trim().length > 0);
}

/**
 * Returns the cached MongoClient connection promise, preserving connections
 * across hot-reloads in development and serverless invocations.
 */
export async function getMongoClient(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI;
  if (!uri || uri.trim().length === 0) {
    throw new Error(
      "MONGODB_URI is not defined. Please set it in your environment variables or .env.local"
    );
  }

  if (process.env.NODE_ENV === "development") {
    if (!global._mongoClientPromise) {
      const client = new MongoClient(uri);
      const connectionPromise = client.connect().catch(async (error: unknown) => {
        if (global._mongoClientPromise === connectionPromise) {
          global._mongoClientPromise = undefined;
        }
        await client.close().catch(() => undefined);
        throw error;
      });
      global._mongoClientPromise = connectionPromise;
    }
    return global._mongoClientPromise;
  }

  if (!cachedClientPromise) {
    const client = new MongoClient(uri);
    const connectionPromise = client.connect().catch(async (error: unknown) => {
      if (cachedClientPromise === connectionPromise) {
        cachedClientPromise = null;
      }
      await client.close().catch(() => undefined);
      throw error;
    });
    cachedClientPromise = connectionPromise;
  }
  return cachedClientPromise;
}

/**
 * Returns the application database instance.
 */
export async function getDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(dbName);
}
