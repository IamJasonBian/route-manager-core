import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from .env file
try {
  // For Netlify Functions, the working directory might be different
  dotenv.config({ path: path.resolve(process.cwd(), '.env') });
} catch (error) {
  console.warn('Error loading .env file from process.cwd(), trying relative path...');
  try {
    // Fallback to relative path from the current file
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
  } catch (innerError) {
    console.warn('Error loading .env file from relative path, using process.env only');
  }
}

// Environment variables with defaults
const config = {
  // Application
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  isProduction: process.env.NODE_ENV === 'production',
  isDevelopment: process.env.NODE_ENV !== 'production',
  
  // Database
  db: {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    name: process.env.DB_NAME,
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
  },
  
  // API
  api: {
    prefix: process.env.API_PREFIX || '/api',
  },
  
  // CORS
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
  },
};

// Validate required environment variables
const requiredEnvVars = [
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'DB_HOST',
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error(`Missing required environment variables: ${missingVars.join(', ')}`);
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  } else {
    console.warn('Running in development mode with missing environment variables.');
  }
}

export default config;
