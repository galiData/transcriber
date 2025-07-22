import React, { useState, useRef, useCallback } from 'react';
import { TranscribeStreamingClient, StartStreamTranscriptionCommand } from '@aws-sdk/client-transcribe-streaming';
import { FetchHttpHandler } from "@aws-sdk/fetch-http-handler";
import { Buffer } from 'buffer';
import S3Service, { createSessionId } from './services/S3Service';
import { aiAgentClean, aiAgentSummary } from './services/AgentService';
import AudioPlayer from './services/AudioPlayer';
import DictionaryEditor from './services/DictionaryEditor';
import TextDisplay from './services/TextDisplay';
import TranscriptionConfig from './components/TranscriptionConfig';

const MedicalTranscription = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [transcription, setTranscription] = useState('');
  const [error, setError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [selectedFileName, setSelectedFileName] = useState('');

  const fileInputRef = useRef(null);
  const [sessionId, setSessionId] = useState(null);
  const recordedChunksRef = useRef([]);

  const completeTranscriptsRef = useRef([]);
  
  const mediaRecorderRef = useRef(null);
  const audioContextRef = useRef(null);
  const workletNodeRef = useRef(null);
  const streamRef = useRef(null);
  const gainNodeRef = useRef(null);
  const analyserRef = useRef(null);
  const animationFrameRef = useRef(null);

  const [isProcessingAI, setIsProcessingAI] = useState(false);

  const [numSpeakers, setNumSpeakers] = useState(10); // Auto-detect speakers up to 10
  const [language, setLanguage] = useState('he-IL'); // Hebrew default
  
  const transcribeClientRef = useRef(null);

  const handleCleanText = async () => {
    if (!sessionId) {
      setError('No active session');
      return;
    }
    
    try {
      setIsProcessingAI(true);
      
      // Create a progress handler
      const handleProgress = (progressText) => {
        setTranscription(progressText);
      };
      
      await aiAgentClean(sessionId, handleProgress);
      
    } catch (error) {
      console.error('Error cleaning text:', error);
      setError('שגיאה בניקוי הטקסט');
    } finally {
      setIsProcessingAI(false);
    }
  };

  const handleAISummary = async () => {
    if (!sessionId) {
      setError('No active session');
      return;
    }
    
    try {
      setIsProcessingAI(true);
      
      // Create a progress handler
      const handleProgress = (progressText) => {
        setTranscription(progressText);
      };
      
      await aiAgentSummary(sessionId, handleProgress);
      
    } catch (error) {
      console.error('Error generating summary:', error);
      setError('שגיאה ביצירת סיכום');
    } finally {
      setIsProcessingAI(false);
    }
  };


  const loadTranscription = async (sessionId) => {
    setError('');
    
    try {
      let attempts = 0;
      const maxAttempts = 120; // 4 minute total (2 second intervals)
      const pollInterval = 2000;

      const pollForTranscription = async () => {
        try {
          const transcriptionText = await S3Service.getFirstTranscription(sessionId);

          if (transcriptionText) {
            setTranscription(transcriptionText);
            return true;
          }
          return false;
        } catch (error) {
          console.log('Polling attempt failed:', error);
          return false;
        }
      };

      const poll = async () => {
        if (attempts >= maxAttempts) {
          throw new Error('Timeout waiting for transcription');
        }

        console.log(`Polling attempt ${attempts + 1}/${maxAttempts} for session ${sessionId}`);
        const found = await pollForTranscription();
        if (!found) {
          attempts++;
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          return poll();
        }
      };

      await poll();
    } catch (error) {
      console.error('Error loading transcription:', error);
      setError(`Failed to load transcription: ${error.message}`);
    }
  };

  const handleFileSelect = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    // List of supported audio MIME types including all MPEG variations
    const supportedAudioTypes = [
      'audio/mpeg',      // MP3/MPEG files
      'audio/x-mpeg',    // Alternative MPEG MIME type
      'video/mpeg',      // MPEG files sometimes use video MIME type
      'audio/mpeg3',     // Alternative MPEG3 MIME type
      'audio/x-mpeg3',   // Alternative MPEG3 MIME type
      'audio/mp3',       // MP3 files
      'audio/x-mp3',     // Alternative MP3 MIME type
      'audio/mp4',       // M4A files
      'audio/wav',       // WAV files
      'audio/x-wav',     // Alternative WAV MIME type
      'audio/webm',      // WebM audio
      'audio/ogg',       // OGG files
      'audio/aac',       // AAC files
      'audio/x-m4a'      // Alternative M4A MIME type
    ];

    // Check if file type is directly supported
    let isSupported = supportedAudioTypes.includes(file.type);

    // If not directly supported, check file extension for .mpeg files
    if (!isSupported && file.name) {
      const extension = file.name.toLowerCase().split('.').pop();
      if (extension === 'mpeg') {
        isSupported = true;
      }
    }

    if (!isSupported) {
      setError('Please select a supported audio file (MPEG, MP3, WAV, M4A, WebM, OGG, AAC)');
      return;
    }

    setSelectedFileName(file.name);
    setUploadingFile(true);
    setError('');

    try {
      const newSessionId = createSessionId();
      setSessionId(newSessionId);

      // Log file information for debugging
      console.log('Uploading file:', {
        name: file.name,
        type: file.type,
        size: file.size,
        extension: file.name.split('.').pop()
      });

      // Upload file to S3
      await S3Service.uploadMedia(file, newSessionId);

      // Clear file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      setSelectedFileName(`Uploaded: ${file.name}`);
      console.log('Starting transcription polling for session:', newSessionId);

      // Start loading the transcription
      await loadTranscription(newSessionId);

    } catch (error) {
      console.error('Error handling file:', error);
      setError('Failed to process file: ' + error.message);
    } finally {
      setUploadingFile(false);
    }
};

  const createTranscribeClient = () => new TranscribeStreamingClient({
    region: process.env.REACT_APP_AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.REACT_APP_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.REACT_APP_AWS_SECRET_ACCESS_KEY
    },
    requestHandler: {
      ...new FetchHttpHandler({
        requestTimeout: 30000 // Ultra-responsive 30 second timeout
      }),
      metadata: {
        handlerProtocol: 'h2'
      }
    },
    extraRequestOptions: {
      duplex: 'half'
    }
  });

  const initializeAudioContext = useCallback(async () => {
    try {
      console.log('Initializing audio context...');
      if (!audioContextRef.current) {
        const context = new AudioContext({
          sampleRate: 16000,
          latencyHint: 'playback' // Fastest possible audio processing
        });

        // Create gain node
        gainNodeRef.current = context.createGain();
        gainNodeRef.current.gain.value = 5.0;

        // Create analyser node with smaller buffer for faster processing
        analyserRef.current = context.createAnalyser();
        analyserRef.current.fftSize = 1024; // Smaller for faster response

        await context.audioWorklet.addModule('/audio-processor.js');
        audioContextRef.current = context;

        console.log('Audio context initialized with gain and analyser');
      }
      return true;
    } catch (error) {
      console.error('Audio initialization error:', error);
      setError('Failed to initialize audio: ' + error.message);
      return false;
    }
  }, []);

  const startTranscription = useCallback(async (stream) => {
    let isStreaming = true;
    const audioQueue = [];
    let queueInterval;
    let lastAudioTime = Date.now();
    let pauseDetectionTimer = null;
  
    try {
      const source = audioContextRef.current.createMediaStreamSource(stream);
      workletNodeRef.current = new AudioWorkletNode(audioContextRef.current, 'audio-processor');
  
      source.connect(workletNodeRef.current);
  
      workletNodeRef.current.port.onmessage = (event) => {
        if (event.data.audioData) {
          const audioData = event.data.audioData;
          const stats = event.data.stats;
  
          const buffer = Buffer.allocUnsafe(audioData.length * 2);
          for (let i = 0; i < audioData.length; i++) {
            buffer.writeInt16LE(audioData[i], i * 2);
          }
  
          if (stats.activeFrames > 0) {
            audioQueue.push(buffer);
            lastAudioTime = Date.now();
            // Audio data queued - force immediate processing
          }
          
          // Only process significant audio to avoid overwhelming the system
  
          setAudioLevel(Math.min(100, event.data.rms * 200));
        }
      };
  
      const audioStream = new ReadableStream({
        start(controller) {
          console.log('Starting audio stream controller...');
          queueInterval = setInterval(() => {
            if (!isStreaming) {
              console.log('Streaming stopped, flushing remaining audio...');
              // Flush remaining audio data before closing
              while (audioQueue.length > 0) {
                const chunk = audioQueue.shift();
                controller.enqueue(chunk);
                console.log('Flushed audio chunk');
              }
              controller.close();
              return;
            }
  
            if (audioQueue.length > 0) {
              const chunk = audioQueue.shift();
              controller.enqueue(chunk);
              // Minimal logging for performance
            }
          }, 20); // Balanced 20ms for smooth streaming without overload
        },
        cancel() {
          isStreaming = false;
          // Flush remaining audio data
          while (audioQueue.length > 0) {
            audioQueue.shift();
          }
          clearInterval(queueInterval);
        }
      });
  
      const command = new StartStreamTranscriptionCommand({
        LanguageCode: language,
        MediaEncoding: 'pcm',
        MediaSampleRateHertz: 16000,
        // Ultra-responsive configuration for minimal latency
        EnableSpeakerIdentification: true,
        MaxSpeakerCount: 2,
        ShowSpeakerLabel: true,
        EnablePartialResultsStabilization: true, // Enable for reliable partial results
        PartialResultsStability: 'low', // Low stability for good responsiveness
        EnableChannelIdentification: false,
        AudioStream: async function* () {
          console.log('Starting audio stream generator...');
          const reader = audioStream.getReader();
          let chunkCount = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                console.log('Audio stream completed');
                break;
              }
              if (value) {
                chunkCount++;
                console.log(`Yielding audio chunk ${chunkCount}, size: ${value.length}`);
                yield { AudioEvent: { AudioChunk: value } };
              }
            }
          } catch (error) {
            console.error('Error in audio stream generator:', error);
          } finally {
            console.log('Audio stream generator cleanup');
            reader.releaseLock();
          }
        }()
      });
  
      // Create transcribe client if not exists
      if (!transcribeClientRef.current) {
        console.log('Creating new AWS Transcribe client...');
        transcribeClientRef.current = createTranscribeClient();
      }
      
      console.log('Sending command to AWS Transcribe...');
      console.log('AWS Credentials check:', {
        hasAccessKey: !!process.env.REACT_APP_AWS_ACCESS_KEY_ID,
        hasSecretKey: !!process.env.REACT_APP_AWS_SECRET_ACCESS_KEY,
        region: process.env.REACT_APP_AWS_REGION || 'us-east-1',
        accessKeyStart: process.env.REACT_APP_AWS_ACCESS_KEY_ID?.substring(0, 8) + '...',
      });
      
      let response;
      try {
        response = await transcribeClientRef.current.send(command);
        console.log('AWS Transcribe connection established successfully');
      } catch (connectionError) {
        console.error('AWS Transcribe connection failed:', connectionError);
        setTranscription(`❌ AWS Connection Error: ${connectionError.message}`);
        throw connectionError;
      }
  
      // Initialize state with more efficient handling
      let currentTranscript = '';
      let currentSpeaker = null;
      let pauseDetected = false;
      let lastTranscriptTime = Date.now();
      completeTranscriptsRef.current = [];
      
      // Test if setTranscription is working
      console.log('Testing setTranscription...');
      setTranscription('🔴 Recording started - waiting for speech...');
      
      console.log('Starting to listen for AWS Transcribe events...');
      
      // Add timeout to catch hanging - more responsive
      let eventCount = 0;
      const timeoutId = setTimeout(() => {
        console.warn('No events received from AWS Transcribe after 5 seconds');
        setTranscription('⚠️ No response from AWS Transcribe - check credentials and connection');
      }, 5000);

      for await (const event of response.TranscriptResultStream) {
        eventCount++;
        console.log(`Received AWS event ${eventCount}:`, event);
        clearTimeout(timeoutId);
        
        if (event.TranscriptEvent?.Transcript?.Results?.[0]) {
          console.log('Found transcript result');
          const result = event.TranscriptEvent.Transcript.Results[0];
          
          // Check for speech pause detection
          const currentTime = Date.now();
          const timeSinceLastTranscript = currentTime - lastTranscriptTime;
          
          // If more than 1.5 seconds has passed since last transcript, consider it a significant pause
          // Balanced to catch natural speaker transitions without splitting sentences
          if (timeSinceLastTranscript > 1500) {
            pauseDetected = true;
            console.log('Pause detected:', timeSinceLastTranscript + 'ms');
          }
          
          lastTranscriptTime = currentTime;
          
          if (result.Alternatives?.[0]) {
            const alternative = result.Alternatives[0];
            const newText = alternative.Transcript || '';
            
            // Minimal result logging for better performance
            
            // Enhanced speaker detection with overlapping speech analysis
            let speakerId = null;
            let speakerLabel = '';
            let allSpeakersInSegment = [];
            
            // Strategy 1: Analyze items to detect multiple speakers in same segment
            if (alternative.Items?.length > 0) {
              const speakerCounts = {};
              const speakerPositions = {};
              
              alternative.Items.forEach((item, index) => {
                if (item.Speaker !== undefined && item.Speaker !== null) {
                  const speaker = item.Speaker.toString();
                  speakerCounts[speaker] = (speakerCounts[speaker] || 0) + 1;
                  
                  if (!speakerPositions[speaker]) {
                    speakerPositions[speaker] = [];
                  }
                  speakerPositions[speaker].push(index);
                }
              });
              
              allSpeakersInSegment = Object.keys(speakerCounts).sort();
              
              // Check for overlapping speech patterns
              if (allSpeakersInSegment.length > 1) {
                // Multiple speakers detected - check if they're overlapping or sequential
                let isOverlapping = false;
                
                // Simple overlap detection: if speakers appear interspersed
                const speakers = alternative.Items
                  .filter(item => item.Speaker !== undefined)
                  .map(item => item.Speaker.toString());
                
                // Enhanced overlap detection with multiple strategies
                
                // Strategy A: Look for interspersed speakers (A-B-A pattern)
                for (let i = 1; i < speakers.length - 1; i++) {
                  if (speakers[i] !== speakers[i-1] && speakers[i] !== speakers[i+1]) {
                    isOverlapping = true;
                    break;
                  }
                }
                
                // Strategy B: Check for rapid speaker switches (more than 2 switches in short segment)
                if (!isOverlapping && speakers.length > 4) {
                  const switchCount = speakers.reduce((count, speaker, index) => {
                    return index > 0 && speaker !== speakers[index - 1] ? count + 1 : count;
                  }, 0);
                  
                  if (switchCount >= 3) { // Multiple quick switches indicate overlap
                    isOverlapping = true;
                  }
                }
                
                // Strategy C: Check if both speakers have significant presence (>30% each)
                if (!isOverlapping && allSpeakersInSegment.length === 2) {
                  const totalWords = Object.values(speakerCounts).reduce((a, b) => a + b, 0);
                  const minThreshold = totalWords * 0.3;
                  
                  if (speakerCounts[allSpeakersInSegment[0]] >= minThreshold && 
                      speakerCounts[allSpeakersInSegment[1]] >= minThreshold) {
                    isOverlapping = true;
                  }
                }
                
                if (isOverlapping) {
                  // True overlapping speech
                  speakerId = allSpeakersInSegment.join(',');
                  speakerLabel = `[דוברים ${allSpeakersInSegment.join(',')} - חפיפה]: `;
                } else {
                  // Sequential speakers in same segment - use dominant speaker
                  const dominantSpeaker = Object.keys(speakerCounts).reduce((a, b) => 
                    speakerCounts[a] > speakerCounts[b] ? a : b
                  );
                  speakerId = dominantSpeaker;
                  speakerLabel = `[דובר ${speakerId}]: `;
                }
              } else if (allSpeakersInSegment.length === 1) {
                // Single clear speaker
                speakerId = allSpeakersInSegment[0];
                speakerLabel = `[דובר ${speakerId}]: `;
              }
            }
            
            // Strategy 2: Check result/alternative level speakers as backup
            if (!speakerId) {
              if (alternative.Speaker !== undefined && alternative.Speaker !== null) {
                speakerId = alternative.Speaker.toString();
                speakerLabel = `[דובר ${speakerId}]: `;
              } else if (result.Speaker !== undefined && result.Speaker !== null) {
                speakerId = result.Speaker.toString();
                speakerLabel = `[דובר ${speakerId}]: `;
              }
            }
            
            // Fallback: continue with current speaker
            if (!speakerId && currentSpeaker) {
              speakerId = currentSpeaker;
              if (speakerId.includes(',')) {
                speakerLabel = `[דוברים ${speakerId}]: `;
              } else {
                speakerLabel = `[דובר ${speakerId}]: `;
              }
            }
  
  
            if (result.IsPartial) {
              // Efficient partial processing - update on meaningful changes
              if (newText !== currentTranscript) {
                
                // Enhanced speaker change detection with overlap handling
                const isDifferentSpeaker = speakerId && currentSpeaker && currentSpeaker !== speakerId;
                
                if (isDifferentSpeaker) {
                  // Commit current transcript when speakers definitively change
                  if (currentTranscript.trim()) {
                    let prevLabel;
                    if (currentSpeaker.includes(',')) {
                      if (currentSpeaker.includes('-')) {
                        prevLabel = `[דוברים ${currentSpeaker.split(' - ')[0]} - חפיפה]: `;
                      } else {
                        prevLabel = `[דוברים ${currentSpeaker}]: `;
                      }
                    } else {
                      prevLabel = `[דובר ${currentSpeaker}]: `;
                    }
                    completeTranscriptsRef.current.push(prevLabel + currentTranscript);
                    
                    // Log the change with overlap detection
                    const changeType = speakerId.includes(',') ? 'overlap detected' : 'speaker change';
                    console.log(`${changeType}:`, currentSpeaker, '->', speakerId);
                  }
                }
                
                // Reset pause detection after processing (regardless of speaker change)
                if (pauseDetected) {
                  pauseDetected = false;
                }
                
                // Update state with zero delay
                currentTranscript = newText;
                if (speakerId) {
                  currentSpeaker = speakerId;
                }
                
                // Ultra-immediate UI update with forced synchronous processing
                const displayText = completeTranscriptsRef.current.length > 0 
                  ? completeTranscriptsRef.current.join('\n') + '\n' + speakerLabel + currentTranscript
                  : speakerLabel + currentTranscript;
                
                // Immediate synchronous update - no delays whatsoever
                setTranscription(displayText);
              }
            } else {
              // For final results - commit the text permanently
              if (newText.trim()) {
                // Conservative speaker change detection for final results
                const isSpeakerChange = speakerId && currentSpeaker && (
                  currentSpeaker !== speakerId // Only on actual different speaker
                );
                
                if (isSpeakerChange) {
                  console.log('Speaker change in final result:', currentSpeaker, '->', speakerId, 'pause:', pauseDetected);
                }
                
                // Reset pause detection after processing final result
                pauseDetected = false;
                
                // Commit the final result with speaker label
                completeTranscriptsRef.current.push(speakerLabel + newText);
                currentTranscript = ''; // Reset current transcript
                
                // Update current speaker for final results
                if (speakerId) {
                  currentSpeaker = speakerId;
                }
                
                // Always update UI immediately for final results
                const displayText = completeTranscriptsRef.current.join('\n');
                setTranscription(displayText);
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('Transcription error details:', {
        name: error.name,
        message: error.message,
        code: error.code,
        statusCode: error.$metadata?.httpStatusCode,
        stack: error.stack
      });
      
      if (error.name === 'CredentialsProviderError') {
        setTranscription('❌ AWS Credentials Error - Check your .env file');
      } else if (error.name === 'NetworkingError') {
        setTranscription('❌ Network Error - Check your internet connection');
      } else if (error.code === 'AccessDeniedException') {
        setTranscription('❌ AWS Access Denied - Check your IAM permissions');
      } else {
        setTranscription(`❌ Error: ${error.message}`);
      }
      
      throw error;
    } finally {
      clearInterval(queueInterval);
      if (pauseDetectionTimer) {
        clearTimeout(pauseDetectionTimer);
      }
    }
  }, [isRecording, language, numSpeakers]);

  const startRecording = async () => {
    console.log('Starting recording...');
    setError('');
    setIsProcessing(true);

    try {
      const initialized = await initializeAudioContext();
      if (!initialized) return;

      // Generate new session ID
      const newSessionId = createSessionId();
      setSessionId(newSessionId);
      recordedChunksRef.current = [];

      console.log('Requesting microphone access...');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
          sampleRate: 16000,
          latency: 0.02, // Balanced 20ms latency for stable streaming
          volume: 1.0,
          googEchoCancellation: true,
          googAutoGainControl: false,
          googNoiseSuppression: false,
          googHighpassFilter: false,
          googTypingNoiseDetection: false
        }
      });

      // Create MediaRecorder to save the audio
      mediaRecorderRef.current = new MediaRecorder(stream);
      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };
      mediaRecorderRef.current.start();

      streamRef.current = stream;
      setIsRecording(true);
      await startTranscription(stream);
    } catch (error) {
      console.error('Recording error:', error);
      // setError('Failed to start recording: ' + error.message); // Show error in console
    } finally {
      setIsProcessing(false);
    }
  };

  const clearTranscription = () => {
    // Refresh the page
    window.location.reload();
  };

  const stopRecording = useCallback(async () => {
    console.log('Stopping recording...');
    setIsRecording(false);
    setIsProcessing(true);

    try {
      // Ultra-minimal flush time for maximum responsiveness
      await new Promise(resolve => setTimeout(resolve, 50));
      
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
        await new Promise(resolve => {
          mediaRecorderRef.current.onstop = resolve;
        });
      }
      
      // Reduced delay to ensure transcription service processes final audio
      await new Promise(resolve => setTimeout(resolve, 100));

      // Create audio blob from recorded chunks
      if (recordedChunksRef.current.length > 0) {
        const audioBlob = new Blob(recordedChunksRef.current, { type: 'audio/wav' });

        // Upload recording to S3
        await S3Service.uploadRecording(audioBlob, sessionId);

        // Upload transcription to S3
        await S3Service.uploadTranscription(transcription, sessionId);

        console.log('Successfully saved recording and transcription');
      }
    } catch (error) {
      console.error('Error saving recording:', error);
      setError('Failed to save recording: ' + error.message);
    } finally {
      // Clean up resources
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }

      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }

      if (workletNodeRef.current) {
        workletNodeRef.current.disconnect();
        workletNodeRef.current = null;
      }

      if (gainNodeRef.current) {
        gainNodeRef.current.disconnect();
        gainNodeRef.current = null;
      }

      if (analyserRef.current) {
        analyserRef.current.disconnect();
        analyserRef.current = null;
      }

      if (audioContextRef.current?.state === 'running') {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }

      mediaRecorderRef.current = null;
      recordedChunksRef.current = [];
      setAudioLevel(0);
      setIsProcessing(false);
    }
  }, [sessionId, transcription]);


  return (
    <div className="min-h-screen bg-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto bg-white rounded-xl shadow-lg p-4 md:p-6">
        <div className="flex justify-between items-center border-b-2 border-blue-300 pb-4 mb-6">
          <div className="flex items-center space-x-4">
            <img 
              src="https://eladsoft.com/wp-content/uploads/2022/04/Elad-logo-color.png" 
              alt="Eladsoft Logo"
              className="h-10 object-contain"
            />
          </div>
          <h1 className="text-2xl md:text-3xl text-blue-800 text-right">
            👨‍⚕️ מערכת תמלול חכמה
          </h1>
        </div>

        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative mb-4 text-right" role="alert">
            <span className="block sm:inline">{error}</span>
          </div>
        )}

        <TranscriptionConfig
                  numSpeakers={numSpeakers}
                  setNumSpeakers={setNumSpeakers}
                  language={language}
                  setLanguage={setLanguage}
                  disabled={isRecording || isProcessing || uploadingFile}
                />

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 bg-gray-50 p-4 rounded-lg mb-6">
          <button
            onClick={startRecording}
            disabled={isRecording || isProcessing || uploadingFile}
            className="btn-primary relative"
          >
            {isProcessing ? (
              <span className="flex items-center justify-center">
                <svg className="animate-spin h-5 w-5 mr-3" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                מתחיל...
              </span>
            ) : (
              'התחל הקלטה ▶️'
            )}
          </button>
          <button
            onClick={stopRecording}
            disabled={!isRecording}
            className="btn-primary"
          >
            עצור הקלטה ⏹️
          </button>
          <button
            onClick={clearTranscription}
            className="btn-primary"
          >
            תמלול חדש 🗑️
          </button>
          <div className="relative">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileSelect}
              accept="audio/*"
              className="hidden"
              id="file-upload"
            />
            <label
              htmlFor="file-upload"
              className={`btn-primary w-full flex items-center justify-center cursor-pointer ${
                uploadingFile ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              {uploadingFile ? (
                <span className="flex items-center">
                  <svg className="animate-spin h-5 w-5 mr-3" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  מעלה...
                </span>
              ) : (
                'העלאת קובץ 📁'
              )}
            </label>
            {selectedFileName && (
              <p className="text-sm text-gray-600 mt-2 text-right break-words">
                {selectedFileName}
              </p>
            )}
          </div>
        </div>

        {isRecording && (
          <div className="mb-4">
            <div className="w-full bg-gray-200 rounded-full h-2.5">
              <div
                className="bg-blue-600 h-2.5 rounded-full transition-all duration-200"
                style={{ width: `${Math.min(100, audioLevel)}%` }}
              />
            </div>
            <p className="text-sm text-gray-500 mt-1 text-right">
              רמת קול: {Math.round(audioLevel)}
            </p>
          </div>
        )}

      {(sessionId && !isRecording) && (
                <AudioPlayer
                  sessionId={sessionId}
                  recordingType={selectedFileName ? 'upload' : 'recording'}
                />
              )}

        {/* AI Processing Controls */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <button
            onClick={handleCleanText}
            disabled={!transcription || isProcessingAI}
            className={`btn-secondary ${(!transcription || isProcessingAI) ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {isProcessingAI ? (
              <span className="flex items-center justify-center">
                <svg className="animate-spin h-5 w-5 mr-3" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                מעבד...
              </span>
            ) : (
              'ניקוי טקסט 🧹'
            )}
          </button>
          <button
            onClick={handleAISummary}
            disabled={!transcription || isProcessingAI}
            className={`btn-secondary ${(!transcription || isProcessingAI) ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {isProcessingAI ? (
              <span className="flex items-center justify-center">
                <svg className="animate-spin h-5 w-5 mr-3" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                מעבד...
              </span>
            ) : (
              'סיכום AI 🤖'
            )}
          </button>
          <DictionaryEditor />
        </div>

        <div className="space-y-4">
            <TextDisplay text={transcription} sessionId={sessionId} />
            </div>
      </div>
    </div>
  );
};

export default MedicalTranscription;