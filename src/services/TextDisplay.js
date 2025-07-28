import React, { useState, useRef, useEffect } from 'react';
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { aiAgentSummary, aiAgentTasks } from './AgentService';

const TextDisplay = ({ text, sessionId }) => {
  const [showCopy, setShowCopy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [currentText, setCurrentText] = useState(text);
  const [textType, setTextType] = useState('original');
  const contentRef = useRef(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setCurrentText(text);
  }, [text]);

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [currentText]);

  const handleCopy = async () => {
    try {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = currentText;
      const textToCopy = tempDiv.textContent || tempDiv.innerText;

      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text:', err);
    }
  };

  const fetchTextFromS3 = async (type) => {
    if (!sessionId) return;

    setIsLoading(true);
    setError('');

    const s3Client = new S3Client({
      region: process.env.REACT_APP_AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.REACT_APP_AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.REACT_APP_AWS_SECRET_ACCESS_KEY
      }
    });

    try {
      let key, processText;
      
      // Set the correct S3 path and text processing logic for each type
      switch (type) {
        case 'original':
          key = `transcriptions/${sessionId}.json`;
          processText = (data) => {
            // Handle different transcription formats
            if (data.results?.transcripts) {
              return data.results.transcripts[0]?.transcript || '';
            } else if (data.content) {
              return data.content;
            }
            return '';
          };
          break;
        case 'tasks':
          key = `tasks/${sessionId}.json`;
          processText = (data) => data.summary || '';
          break;
        case 'summary':
          key = `ai-summaries/${sessionId}.json`;
          processText = (data) => data.summary || '';
          break;
        default:
          throw new Error(`Unknown text type: ${type}`);
      }

      const command = new GetObjectCommand({
        Bucket: "product.transcriber",
        Key: key
      });

      const response = await s3Client.send(command);
      const reader = response.Body.getReader();
      const decoder = new TextDecoder('utf-8');
      let result = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        result += decoder.decode(value, { stream: true });
      }

      const data = JSON.parse(result);
      const processedText = processText(data);
      setCurrentText(processedText?.split('\\n').join('\n') || '');
      setTextType(type);
    } catch (error) {
      console.error(`Error fetching ${type} text:`, error);
      throw error; // Re-throw to allow fallback logic
    } finally {
      setIsLoading(false);
    }
  };

  const getButtonClassName = (type) => {
    const baseClasses = "px-3 py-1 rounded-md text-sm transition-all duration-200 text-white";
    const isActive = textType === type;
    
    switch (type) {
      case 'copy':
        return `${baseClasses} bg-blue-500 hover:bg-blue-600`;
      case 'original':
        return `${baseClasses} bg-blue-500 hover:bg-blue-600 ${isActive 
          ? 'ring-2 ring-blue-300' 
          : ''}`;
      case 'tasks':
        return `${baseClasses} bg-blue-500 hover:bg-blue-600 ${isActive 
          ? 'ring-2 ring-blue-300' 
          : ''}`;
      case 'summary':
        return `${baseClasses} bg-blue-500 hover:bg-blue-600 ${isActive 
          ? 'ring-2 ring-blue-300' 
          : ''}`;
      default:
        return `${baseClasses} bg-blue-500 hover:bg-blue-600`;
    }
  };

  return (
    <div className="relative">
      <div className="absolute top-0 left-0 right-0 h-12 flex justify-between items-center px-2 z-10 gap-2 bg-white bg-opacity-90">
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className={getButtonClassName('copy')}
            disabled={isLoading}
          >
            {copied ? (
              <span className="flex items-center gap-1">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                הועתק!
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                </svg>
                העתק
              </span>
            )}
          </button>

          <button
            onClick={async () => {
              if (textType === 'original') {
                return; // Already showing original text
              }
              try {
                // Fetch original transcription from S3
                await fetchTextFromS3('original');
              } catch (error) {
                console.error('Original transcription not found in S3:', error);
                setError('No transcription found for this session');
              }
            }}
            className={getButtonClassName('original')}
            disabled={isLoading}
          >
            טקסט גולמי
          </button>

          <button
            onClick={async () => {
              if (textType === 'tasks') {
                // If already showing tasks, go back to original
                setCurrentText(text);
                setTextType('original');
              } else {
                // ONLY fetch tasks from S3 - no generation
                try {
                  await fetchTextFromS3('tasks');
                } catch (error) {
                  console.error('Tasks not found in S3:', error);
                  setError('No tasks found for this session');
                  // Don't generate - just show error
                }
              }
            }}
            className={getButtonClassName('tasks')}
            disabled={isLoading}
          >
            משימות
          </button>

          <button
            onClick={async () => {
              if (textType === 'summary') {
                // If already showing summary, go back to original
                setCurrentText(text);
                setTextType('original');
              } else {
                // ONLY fetch summary from S3 - no generation
                try {
                  await fetchTextFromS3('summary');
                } catch (error) {
                  console.error('Summary not found in S3:', error);
                  setError('No summary found for this session');
                }
              }
            }}
            className={getButtonClassName('summary')}
            disabled={isLoading}
          >
            סיכום
          </button>
        </div>
      </div>

      <div className="group relative h-64 w-full overflow-hidden" style={{ resize: 'vertical' }}>
        {isLoading && (
          <div className="absolute inset-0 bg-white bg-opacity-75 flex items-center justify-center z-20">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
          </div>
        )}
        
        {error && (
          <div className="absolute top-12 left-0 right-0 text-red-500 text-center bg-red-100 p-2 z-20">
            {error}
          </div>
        )}

        <div
          ref={contentRef}
          dangerouslySetInnerHTML={{ __html: currentText.replace(/\\n/g, '<br/>') }}
          className="absolute inset-0 p-4 border-2 border-blue-300 rounded-lg text-right focus:outline-none focus:border-blue-500 overflow-auto bg-white"
          dir="rtl"
          style={{
            whiteSpace: 'pre-wrap',
            marginTop: '3rem'
          }}
        />

        <div className="absolute bottom-0 right-2 w-4 h-4 cursor-ns-resize opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            className="w-4 h-4 text-gray-400"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 13l-7 7-7-7m14-8l-7 7-7-7"
            />
          </svg>
        </div>
      </div>
    </div>
  );
};

export default TextDisplay;