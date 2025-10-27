import { google } from '@ai-sdk/google';
import 'dotenv/config';

// Verify API key is present
if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
  throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not set in environment variables');
}

// Configure single Gemini model
export const gemini = google('gemini-2.0-flash');

// Export as default for easy use
export default gemini;
