"use client";
import { useState } from 'react';

export default function Home() {
  const [timeline, setTimeline] = useState<string[]>([]);
  const [text, setText] = useState<string>('');

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedText = event.clipboardData.getData('text');
    setText(text + pastedText);
    setTimeline([...timeline, `Pasted: ${pastedText}`]);
  };

  const handleInsert = () => {
    const aiText = 'AI Inserted Text'; // Placeholder for AI text
    setText(text + aiText);
    setTimeline([...timeline, `Inserted: ${aiText}`]);
  };

  const handleGenerateCertificate = () => {
    alert('Certificate Generated!'); // Placeholder for certificate generation
  };

  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-gray-900 font-sans dark:bg-black">
      <main className="flex flex-1 w-full max-w-3xl flex-col items-center justify-between py-32 px-16 bg-gray-800 dark:bg-black sm:items-start">
        <textarea
          className="w-full h-64 p-4 border border-gray-600 rounded-md bg-gray-700 text-white"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={handlePaste}
          placeholder="Type here..."
        />
        <div className="flex justify-between w-full mt-4">
          <button onClick={handleInsert} className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-500">Insert</button>
          <button onClick={handleGenerateCertificate} className="bg-green-600 text-white px-4 py-2 rounded-md hover:bg-green-500">Generate Certificate</button>
        </div>
      </main>
      <div className="w-full bg-gray-800 text-white p-4">
        <h2 className="text-lg font-semibold">Creation Timeline</h2>
        <ul>
          {timeline.map((event, index) => (
            <li key={index}>{event}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
