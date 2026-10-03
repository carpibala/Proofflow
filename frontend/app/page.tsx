"use client";
import { useState, useEffect } from 'react';

// TypeScript types for JSON data structure
type DocumentContent = 
  | { type: 'paragraph'; content: string; marks?: Array<{ type: 'bold' | 'italic' | 'underline' }> }
  | { type: 'formatted'; content: string; style: string; };

interface EventLog {
  operationId: string;
  baseVersion: number;
  aiResponseId?: string;
}

export default function Home() {
  const [timeline, setTimeline] = useState<EventLog[]>([]);
  const [text, setText] = useState<DocumentContent[]>([
    { type: 'paragraph', content: 'AI in Education: The integration of AI in educational settings can enhance learning experiences.' }
  ]);
  const [baseVersion, setBaseVersion] = useState<number>(0);
  const [hoveredEventId, setHoveredEventId] = useState<string | null>(null);

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedText = event.clipboardData.getData('text');
    const newContent: DocumentContent = { type: 'paragraph', content: pastedText };
    setText([...text, newContent]);
    const newEvent: EventLog = { operationId: Date.now().toString(), baseVersion: baseVersion + 1 };
    setTimeline([...timeline, newEvent]);
  };

  const handleInsert = () => {
    const aiText = 'AI can provide personalized learning experiences.';
    const newContent: DocumentContent = { type: 'formatted', content: aiText, style: 'bold' };
    setText([...text, newContent]);
    const newEvent: EventLog = { operationId: Date.now().toString(), baseVersion: baseVersion + 1, aiResponseId: 'AI-12345' };
    setTimeline([...timeline, newEvent]);
  };

  const handleGenerateCertificate = () => {
    alert('Certificate Generated!');
  };

  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-slate-50 font-sans">
      <header className="flex justify-between items-center w-full p-4 bg-white border-b border-gray-300">
        <h1 className="text-xl font-bold">AI in the Classroom: Opportunities and Ethics</h1>
        <div className="flex items-center">
          <span className="w-2 h-2 bg-green-500 rounded-full mr-2" />
          <button onClick={handleGenerateCertificate} className="bg-teal-500 text-white px-4 py-2 rounded-md hover:bg-teal-400">Generate Certificate</button>
        </div>
      </header>
      <main className="flex flex-1 w-full max-w-3xl flex-col items-center justify-between py-32 px-16 bg-white">
        <textarea
          className="w-full h-64 p-4 border border-gray-600 rounded-md bg-gray-100 text-black"
          value={text.map(item => item.content).join('\n')}
          onChange={(e) => setText(e.target.value.split('\n').map(content => ({ type: 'paragraph', content })))}
          onPaste={handlePaste}
          placeholder="Type here..."
        />
        <div className="flex justify-between w-full mt-4">
          <button onClick={handleInsert} className="bg-teal-500 text-white px-4 py-2 rounded-md hover:bg-teal-400">Insert</button>
        </div>
      </main>
      <aside className="w-full bg-gray-100 text-black p-4">
        <h2 className="text-lg font-semibold">Creation Timeline</h2>
        <ul>
          {timeline.map((event, index) => (
            <li key={index} onMouseEnter={() => setHoveredEventId(event.operationId)} onMouseLeave={() => setHoveredEventId(null)} className={hoveredEventId === event.operationId ? 'bg-slate-200' : ''}>{`Operation ID: ${event.operationId}, Base Version: ${event.baseVersion}`}</li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
