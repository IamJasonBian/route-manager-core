import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Try multiple locations for the .env file
const loadEnv = () => {
  const envPaths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../../.env'),
    path.resolve(process.cwd(), '../../../.env')
  ];

  for (const envPath of envPaths) {
    try {
      const result = config({ path: envPath });
      if (!result.error) {
        console.log(`Loaded .env from: ${envPath}`);
        return true;
      }
    } catch (error) {
      console.warn(`Failed to load .env from ${envPath}:`, error.message);
    }
  }
  
  console.warn('No .env file found, using process.env only');
  return false;
};

// Load environment variables
loadEnv();

// Log loaded environment (except sensitive data)
console.log('Environment variables loaded for Netlify Functions');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('DB_HOST:', process.env.DB_HOST);

// This middleware will run before all functions
export const onRequest = (handler) => async (event, context) => {
  // Add any pre-processing here
  console.log(`[${new Date().toISOString()}] ${event.httpMethod} ${event.path}`);
  return handler(event, context);
};
