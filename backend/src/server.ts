import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import router from './routes/chat';
import authRouter from './routes/auth';

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL;
console.log('Starting Backend');
app.use(cors({
    origin:FRONTEND_URL,
    credentials:true,
}));

app.use(express.json({limit:'10mb'}));

app.use((req,res,next)=>{
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});
//TESTING THE 100XSWE PROJECT
app.use('/api',router);
app.use('/auth', authRouter);

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