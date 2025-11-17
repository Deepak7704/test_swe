import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import router from './routes/chat';
import authRouter from './routes/auth';
import rateLimit from 'express-rate-limit';

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL;
console.log('Starting Backend');
app.use(cors({
    origin:FRONTEND_URL,
    credentials:true,
}));

app.use(express.json({limit:'10mb'}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message:
    'Too many requests from this IP, please try again after 15 minutes',
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
})


app.use((req,res,next)=>{
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});
//TESTING THE 100XSWE PROJECT
app.use('/api',router);
app.use('/auth', authLimiter, authRouter);

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({
    error: err.message || 'Internal server error',
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`CORS enabled for: ${FRONTEND_URL}`);
  console.log(`\n Environment:`);
  console.log(`   - Gemini API: ${process.env.GOOGLE_GENERATIVE_AI_API_KEY ? '✓ Configured' : '✗ Missing'}`);
  console.log(`   - E2B API: ${process.env.E2B_API_KEY ? '✓ Configured' : '✗ Missing'}`);
  console.log('\n');
});