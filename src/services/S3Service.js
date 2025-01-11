import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';

class S3Service {
  constructor() {
    this.client = new S3Client({
      region: process.env.REACT_APP_AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.REACT_APP_AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.REACT_APP_AWS_SECRET_ACCESS_KEY
      }
    });
    this.bucketName = 'ai.hadassah.frankfurt';
  }

  async getFirstTranscription(sessionId) {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: `transcriptions/${sessionId}.json` 
      });

      const response = await this.client.send(command);
      
      if (!response.Body) {
        throw new Error('No transcription found');
      }

      const reader = response.Body.getReader();
      const decoder = new TextDecoder('utf-8');
      let result = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        result += decoder.decode(value, { stream: true });
      }
      
      // Parse the JSON and extract the content
      const transcriptionData = JSON.parse(result);
      if (!transcriptionData || !transcriptionData.results || !transcriptionData.results.transcripts) {
        throw new Error('Invalid transcription format');
      }
      
      // Get the first transcript
      const firstTranscript = transcriptionData.results.transcripts[0]?.transcript || '';
      return firstTranscript;
      
    } catch (error) {
      if (error.name === 'NoSuchKey') {
        return null; // File doesn't exist yet
      }
      console.error('Error getting transcription:', error);
      throw error;
    }
  }

  async uploadRecording(audioBlob, sessionId) {
    try {
      // Create a presigned URL for the upload
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: `recordings/${sessionId}.wav`,
        ContentType: 'audio/wav'
      });

      const signedUrl = await getSignedUrl(this.client, command, { expiresIn: 3600 });

      // Use fetch to upload directly to S3 using the presigned URL
      const response = await fetch(signedUrl, {
        method: 'PUT',
        body: audioBlob,
        headers: {
          'Content-Type': 'audio/wav'
        }
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
      }

      console.log(`Recording saved successfully for session: ${sessionId}`);
      return true;
    } catch (error) {
      console.error('Error uploading recording:', error);
      throw error;
    }
  }

  async uploadTranscription(transcriptionText, sessionId) {
    try {
      const transcriptionData = {
        sessionId,
        timestamp: new Date().toISOString(),
        content: transcriptionText
      };

      // Create a presigned URL for the transcription upload
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: `transcriptions/${sessionId}.json`,
        ContentType: 'application/json'
      });

      const signedUrl = await getSignedUrl(this.client, command, { expiresIn: 3600 });

      // Use fetch to upload directly to S3 using the presigned URL
      const response = await fetch(signedUrl, {
        method: 'PUT',
        body: JSON.stringify(transcriptionData),
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
      }

      console.log(`Transcription saved successfully for session: ${sessionId}`);
      return true;
    } catch (error) {
      console.error('Error uploading transcription:', error);
      throw error;
    }
  }

  async uploadMedia(file, sessionId) {
    try {
      const fileName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');

      console.log('Region:', process.env.REACT_APP_AWS_REGION);
      console.log('Has Access Key:', !!process.env.REACT_APP_AWS_ACCESS_KEY_ID);
      console.log('Has Secret Key:', !!process.env.REACT_APP_AWS_SECRET_ACCESS_KEY);
      
      // Verify the file and sessionId
      if (!file || !sessionId) {
        throw new Error('Missing required parameters');
      }
  
      // Log the file details for debugging
      console.log('Uploading file:', {
        type: file.type,
        size: file.size,
        name: fileName
      });
  
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: `media-loads/${sessionId}`,
        ContentType: file.type
      });
  
      const signedUrl = await getSignedUrl(this.client, command, { expiresIn: 3600 });
      
      // Log the signed URL (remove in production)
      console.log('Generated signed URL:', signedUrl);
  
      const response = await fetch(signedUrl, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': file.type
        }
      });
  
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Upload failed: ${response.status} ${response.statusText} - ${errorText}`);
      }
  
      return {
        success: true,
        key: `media-loads/${sessionId}`,
        sessionId: sessionId
      };
    } catch (error) {
      console.error('Detailed upload error:', {
        message: error.message,
        stack: error.stack,
        name: error.name
      });
      throw error;
    }
  }
}

export const createSessionId = () => uuidv4();
export default new S3Service();
