require('dotenv').config();
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('Could not connect to MongoDB', err));

const { OpenAI } = require('openai');
const bodyParser = require('body-parser');
const express = require('express');
const path = require('path');
const multer = require('multer');

const PORT = process.env.PORT || 3001;

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const Interaction = require('./models/Interaction');
const Note = require('./models/Note');
const Document = require('./models/Document');
const EventLog = require('./models/EventLog');
const retrievalService = require('./services/retrievalService');
retrievalService.initialize().catch(err => console.error('Failed to initialize retrieval service:', err));

const documentProcessor = require('./services/documentProcessor');
const embeddingService = require('./services/embeddingService');
const upload = multer({ dest: 'uploads/' });

function buildTutorPrompt(context, currentTopic, problemContext) {
  const topicLine = currentTopic ? `\nCurrent topic: ${currentTopic}` : '';
  const contextSection = context
    ? `\nReference material:\n${context}`
    : '\nNo reference material uploaded yet — answer from general knowledge.';
  const problemSection = problemContext && typeof problemContext === 'object'
    ? `\nStructured problem-solving context:\n${[
        'The user is working through a practice problem.',
        problemContext.problem ? `Problem: ${problemContext.problem}` : null,
        typeof problemContext.stepIndex === 'number' ? `Current step: ${problemContext.stepIndex + 1}` : null,
        problemContext.stepInstruction ? `Current step instruction: ${problemContext.stepInstruction}` : null,
        'Use this context when the user asks a question during the problem-solving process.',
        'Answer directly and specifically using the current problem context.',
        'Do not ask the user to restate the problem context unless something is missing.',
        'Do not reveal the expected answer for the current step unless the user explicitly asks to show it.'
      ].filter(Boolean).join('\n')}`
    : '';

  return `You are a direct, helpful study assistant helping a student learn.${topicLine}

YOUR RULES:
1. Answer the user's question directly and clearly.
2. Use the reference materials when they are available.
3. If context is missing or unclear, say so and provide the best answer you can.
4. Keep responses concise unless the user asks for more detail.
5. When the user asks for help on a problem, explain the reasoning step by step and include the final answer when appropriate.
6. When evaluating a quiz answer, clearly state whether it is correct or not, then explain why briefly.${problemSection}${contextSection}`;
}

app.post('/chat', async (req, res) => {
  try {
    const {
      history = [],
        input: userInput,
        message,
        participantID,
        currentTopic,
        mode,        // 'normal' | 'quiz_eval'
        retrievalMethod,
        problemContext
    } = req.body;

    const userMessage = userInput || message;
    if (!participantID) return res.status(400).send('Participant ID is required');

    // Retrieve relevant chunks
    const chunks = await retrievalService.retrieve(userMessage, {
      method: retrievalMethod || 'semantic',
      topK: 3
    });

    const scores = chunks.map(c => c.score || 0);
    const confidence = {
      topScore: scores.length > 0 ? Math.max(...scores) : 0,
      avgScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
      chunkCount: chunks.length
    };

    const contextText = chunks.length > 0
      ? chunks.map((c, i) => `[${i + 1}] ${c.chunkText}`).join('\n\n')
      : null;

    const systemPrompt = buildTutorPrompt(contextText, currentTopic, problemContext);

    const safeHistory = Array.isArray(history)
      ? history
          .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
          .map(m => ({ role: m.role, content: String(m.content ?? '') }))
      : [];

    // In quiz_eval mode, append an instruction so the model evaluates the answer
    const finalUserMessage = mode === 'quiz_eval'
      ? `[Quiz answer to evaluate]: ${userMessage}`
      : userMessage;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...safeHistory
    ];

    messages.push({ role: 'user', content: finalUserMessage });

    const chatResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 300,
    });

    const botResponse = chatResponse.choices[0].message.content.trim();

    const interaction = new Interaction({
      participantID,
      userInput: userMessage,
      botResponse,
      currentTopic: currentTopic || null,
      retrievalMethod: retrievalMethod || 'semantic',
      retrievedChunks: chunks.map(c => ({
        documentId: c.documentId,
        documentName: c.documentName,
        chunkIndex: c.chunkIndex,
        chunkText: c.chunkText,
        score: c.score
      })),
      confidence
    });

    res.json({ response: botResponse, confidence, retrievalMethod: retrievalMethod || 'semantic' });
    await interaction.save();

  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ response: 'Error: ' + err.message });
  }
});

function fallbackTopicsForSubject(subject) {
  const base = String(subject || '').toLowerCase();

  if (base.includes('interest')) {
    return [
      'Define and interpret interest',
      'Identify principal, rate, and time',
      'Apply the simple interest formula',
      'Apply the compound interest formula'
    ];
  }

  if (base.includes('algebra')) {
    return [
      'Identify variables and constants',
      'Solve one-step equations',
      'Solve multi-step equations',
      'Check answers by substitution'
    ];
  }

  return [
    `Introduction to ${subject}`,
    `Key ideas in ${subject}`,
    `Practice and application in ${subject}`,
    `Review and mastery in ${subject}`
  ];
}

function parseTopicsPayload(rawText, subject) {
  const cleaned = String(rawText || '').replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed.filter(Boolean).map(String);
    if (parsed && Array.isArray(parsed.topics)) return parsed.topics.filter(Boolean).map(String);
  } catch (_) {
    // Fall through to regex extraction below.
  }

  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) return parsed.filter(Boolean).map(String);
    } catch (_) {
      // ignore and fall back
    }
  }

  const bulletMatches = cleaned
    .split(/\n+/)
    .map(line => line.replace(/^[-*\d.\)\s]+/, '').trim())
    .filter(line => line.length > 0);

  if (bulletMatches.length > 0) return bulletMatches.slice(0, 6);

  return fallbackTopicsForSubject(subject);
}

app.post('/generate-topics', async (req, res) => {
  try {
    const { subject, participantID } = req.body;
    if (!subject) return res.status(400).json({ error: 'Subject is required' });

    // Pull document context if any
    const docs = await Document.find({ processingStatus: 'completed' }).limit(3);
    const docContext = docs.length > 0
      ? docs.map(d => d.text?.slice(0, 800)).join('\n\n')
      : null;

    const prompt = docContext
      ? `Based on these reference materials, generate a concise ordered list of learning topics for the subject "${subject}".\n\nMaterials:\n${docContext}\n\nReturn ONLY a JSON array of topic name strings, e.g. ["Topic 1", "Topic 2"]. No markdown, no extra text.`
      : `Generate a concise ordered list of learning topics for the subject "${subject}".\n\nReturn ONLY a JSON array of topic name strings, e.g. ["Topic 1", "Topic 2"]. No markdown, no extra text.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
    });

    const raw = response.choices[0].message.content.trim();
    const topics = parseTopicsPayload(raw, subject);

    if (!Array.isArray(topics) || topics.length === 0) {
      return res.json({ topics: fallbackTopicsForSubject(subject) });
    }

    res.json({ topics });
  } catch (err) {
    console.error('Generate topics error:', err);
    res.json({ topics: fallbackTopicsForSubject(req.body?.subject) });
  }
});

app.post('/quiz', async (req, res) => {
  try {
    const { topic, participantID, history = [] } = req.body;
    if (!topic) return res.status(400).json({ error: 'Topic is required' });

    // Pull relevant chunks for the topic
    const chunks = await retrievalService.retrieve(topic, { method: 'semantic', topK: 2 });
    const contextText = chunks.length > 0
      ? chunks.map(c => c.chunkText).join('\n\n')
      : null;

    const contextSection = contextText ? `\nContext:\n${contextText}` : '';

    const prompt = `Generate a single check-in quiz question for a student learning about "${topic}".${contextSection}

The question should test genuine understanding, not just recall.
Return ONLY a JSON object with this exact shape:
{
  "question": "...",
  "type": "short_answer",
  "hint": "Think about..."
}
No markdown, no extra text.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
    });

    const raw = response.choices[0].message.content.trim();
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const quiz = JSON.parse(cleaned);

    res.json(quiz);
  } catch (err) {
    console.error('Quiz error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/practice-problem', async (req, res) => {
  try {
    const { topic, participantID, history = [] } = req.body;
    if (!topic) return res.status(400).json({ error: 'Topic is required' });

    // Pull relevant chunks for the topic
    const chunks = await retrievalService.retrieve(topic, { method: 'semantic', topK: 3 });
    const contextText = chunks.length > 0
      ? chunks.map(c => c.chunkText).join('\n\n')
      : null;

    const contextSection = contextText ? `\nContext:\n${contextText}` : '';

    const prompt = `Generate a practice problem for a student learning about "${topic}".${contextSection}

The problem should have 4-5 clear steps that build on each other. For each step, specify what the student should do and what counts as a correct answer.

Return ONLY a JSON object with this exact shape (no markdown, no extra text):
{
  "problem": "Full problem statement",
  "steps": [
    {
      "number": 1,
      "instruction": "What the student should do in this step",
      "answer": "What we're looking for in their answer",
      "hint": "A hint if they get stuck (optional)"
    }
  ]
}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
    });

    const raw = response.choices[0].message.content.trim();
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const problem = JSON.parse(cleaned);

    res.json(problem);
  } catch (err) {
    console.error('Practice problem error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/evaluate-step', async (req, res) => {
  try {
    const { topic, stepNumber, instruction, expectedAnswer, studentAnswer, hint, participantID } = req.body;

    const prompt = `A student is learning about "${topic}" and working through a practice problem.

Step ${stepNumber}: ${instruction}
Expected approach/answer: ${expectedAnswer}${hint ? `\nHint to offer if needed: ${hint}` : ''}

The student submitted: "${studentAnswer}"

Evaluate whether this is correct or on the right track. Be encouraging and specific.
If incorrect, point them toward the right approach without giving the full answer.
Keep your response to 1-2 sentences max.

Respond with ONLY a JSON object (no markdown):
{
  "correct": true/false,
  "feedback": "Your feedback here"
}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 100,
    });

    const raw = response.choices[0].message.content.trim();
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const evaluation = JSON.parse(cleaned);

    res.json(evaluation);
  } catch (err) {
    console.error('Evaluate step error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/notes', async (req, res) => {
  try {
    const { participantID, title, content, topic, isFormula, messageRef, isHighlight } = req.body;
    if (!participantID || !content) return res.status(400).json({ error: 'Missing fields' });
    const note = new Note({
      participantID,
      title: (title || 'Untitled').trim() || 'Untitled',
      content,
      topic: topic || null,
      isFormula: !!isFormula,
      messageRef: messageRef || null,
      isHighlight: !!isHighlight
    });
    await note.save();
    res.json(note);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/notes/:participantID', async (req, res) => {
  try {
    const notes = await Note.find({ participantID: req.params.participantID }).sort({ createdAt: 1 });
    res.json(notes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/notes/:id', async (req, res) => {
  try {
    const { title, content, isFormula } = req.body;
    if (!content || !String(content).trim()) {
      return res.status(400).json({ error: 'Content is required' });
    }

    const updated = await Note.findByIdAndUpdate(
      req.params.id,
      {
        title: (title || 'Untitled').trim() || 'Untitled',
        content: String(content).trim(),
        isFormula: !!isFormula
      },
      { new: true }
    );

    if (!updated) return res.status(404).json({ error: 'Note not found' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/notes/:id', async (req, res) => {
  try {
    await Note.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/upload-document', upload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const processed = await documentProcessor.processDocument(req.file);
    const chunksWithEmbeddings = await embeddingService.generateEmbeddings(processed.chunks);
    await Document.create({
      filename: req.file.originalname,
      text: processed.fullText,
      chunks: chunksWithEmbeddings.map(c => ({
        chunkIndex: c.chunkIndex,
        text: c.text,
        embedding: c.embedding || []
      })),
      processingStatus: 'completed'
    });
    await retrievalService.rebuildIndex();
    res.json({ status: 'ok', filename: req.file.originalname, chunkCount: chunksWithEmbeddings.length });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Failed to process document' });
  }
});

app.get('/documents', async (req, res) => {
  const docs = await Document.find({})
    .select('_id filename processingStatus processedAt')
    .sort({ processedAt: -1 });
  res.json(docs);
});

app.post('/log-event', async (req, res) => {
  const { participantID, eventType, elementName, timestamp } = req.body;
  try {
    const event = new EventLog({ participantID, eventType, elementName, timestamp });
    await event.save();
    res.status(200).send('ok');
  } catch (err) {
    res.status(500).send('Error');
  }
});

app.post('/history', async (req, res) => {
  const { participantID, limit } = req.body;
  if (!participantID) return res.status(400).send('Participant ID is required');
  try {
    const n = parseInt(limit) || 10;
    const interactions = await Interaction.find({ participantID })
      .sort({ timestamp: -1 })
      .limit(n);
    res.json({ history: interactions.reverse() });
  } catch (err) {
    res.status(500).send('Error');
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`compoundify running on port ${PORT}`);
});
