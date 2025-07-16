import React, { useState, useRef, useEffect } from 'react';
import { Play, Pause, RotateCcw } from 'lucide-react';
import { GetObjectCommand } from "@aws-sdk/client-s3";
import S3Service from './S3Service';

const AudioPlayer = ({ sessionId, recordingType }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [retryCount, setRetryCount] = useState(0);
  const retryCountRef = useRef(0);

  const audioRef = useRef(null);
  const s3Client = useRef(S3Service.client);
  const pollingTimeoutRef = useRef(null);

  useEffect(() => {
    loadAudioWithRetry();
    return () => {
      if (pollingTimeoutRef.current) {
        clearTimeout(pollingTimeoutRef.current);
      }
    };
  }, [sessionId, recordingType]);

  const loadAudioWithRetry = async () => {
    if (!sessionId) return;

    setIsLoading(true);
    setError(null);

    const maxRetries = 30; // 1 minute with 2-second intervals
    const retryInterval = 2000;

    retryCountRef.current = 0;
    setRetryCount(0);

    const attemptLoad = async () => {
      try {
        const prefix = recordingType === 'upload' ? 'media-loads' : 'recordings';
        const key = `${prefix}/${sessionId}${recordingType === 'recording' ? '.wav' : ''}`;

        const command = new GetObjectCommand({
          Bucket: "product.transcriber",
          Key: key
        });

        const response = await s3Client.current.send(command);
        const chunks = [];
        const reader = response.Body.getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }

        const blob = new Blob(chunks, {
          type: recordingType === 'recording' ? 'audio/wav' : 'audio/*'
        });
        const url = URL.createObjectURL(blob);

        if (audioRef.current) {
          audioRef.current.src = url;
          audioRef.current.load();
          setIsLoading(false);
          setError(null);
          setRetryCount(0);
        }
        return true;
      } catch (error) {
        console.log(`Attempt ${retryCountRef.current + 1}/${maxRetries} failed:`, error);
        return false;
      }
    };

    const pollForAudio = async () => {
      const success = await attemptLoad();

      if (success) {
        setIsLoading(false);
        return;
      }

      if (retryCountRef.current < maxRetries) {
        retryCountRef.current += 1;
        setRetryCount(retryCountRef.current);
        pollingTimeoutRef.current = setTimeout(pollForAudio, retryInterval);
      } else {
        setIsLoading(false);
        setError('Could not load audio file after 1 minute');
      }
    };

    pollForAudio();
  };

  const togglePlayPause = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
    }
  };

  const handleSeek = (e) => {
    const time = parseFloat(e.target.value);
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      setCurrentTime(time);
    }
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleReset = () => {
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      setCurrentTime(0);
      if (isPlaying) {
        audioRef.current.pause();
        setIsPlaying(false);
      }
    }
  };

  return (
    <div className="w-full bg-white rounded-lg shadow-sm p-4 mb-4">
      <audio
        ref={audioRef}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={() => setIsPlaying(false)}
      />

      {error ? (
        <div className="text-red-500 text-center py-2">
          {error}
          <button
            onClick={loadAudioWithRetry}
            className="ml-2 text-blue-500 hover:text-blue-700 underline"
          >
            Try again
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-center gap-4">
            <button
              onClick={handleReset}
              className="p-2 text-gray-600 hover:text-gray-800 disabled:opacity-50"
              disabled={isLoading || !duration}
            >
              <RotateCcw size={20} />
            </button>
            <button
              onClick={togglePlayPause}
              className="p-2 bg-blue-600 text-white rounded-full hover:bg-blue-700 disabled:opacity-50"
              disabled={isLoading || !duration}
            >
              {isLoading ? (
                <div className="flex flex-col items-center">
                  <div className="w-5 h-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  {retryCount > 0 && (
                    <div className="text-xs mt-1">
                      Loading... ({retryCount}/30)
                    </div>
                  )}
                </div>
              ) : isPlaying ? (
                <Pause size={20} />
              ) : (
                <Play size={20} />
              )}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600 min-w-[40px]">
              {formatTime(currentTime)}
            </span>
            <input
              type="range"
              min="0"
              max={duration || 0}
              value={currentTime}
              onChange={handleSeek}
              className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
              disabled={isLoading || !duration}
            />
            <span className="text-sm text-gray-600 min-w-[40px]">
              {formatTime(duration)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

export default AudioPlayer;