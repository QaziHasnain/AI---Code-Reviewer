import '../config/env.js';
import { PrismaClient } from '@prisma/client';
import { GeminiReviewProvider } from '../reviews/provider.js';
import { ReviewWorker } from '../reviews/worker.js';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('GEMINI_API_KEY is required to start the review worker');
const prisma = new PrismaClient();
const worker = new ReviewWorker(prisma, new GeminiReviewProvider(apiKey, process.env.GEMINI_MODEL));
let stopping = false;
const stop = () => { if (!stopping) { stopping = true; worker.stop(); } };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try { await worker.run(); }
finally { await worker.shutdown(); await prisma.$disconnect(); }
