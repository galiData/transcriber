import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import TextReplacement from './TextReplacement';

async function applyMedicalReplacements(text) {
  try {
    // Get dictionary entries from DynamoDB
    const dictionary = await getMedicalDictionary();

    // Create a map of phrases to their display values
    const replacementMap = new Map();
    dictionary.forEach(entry => {
      if (entry.Phrase && entry.DisplayAs) {
        replacementMap.set(entry.Phrase.toLowerCase(), entry.DisplayAs);
      }
    });

    // Sort phrases by length (longest first) to handle overlapping terms
    const sortedPhrases = Array.from(replacementMap.keys()).sort((a, b) => b.length - a.length);

    let processedText = text;
    let replacements = [];
    let currentPosition = 0;

    // First pass: collect all replacements with their positions
    for (const phrase of sortedPhrases) {
      const lowerText = processedText.toLowerCase();
      let startIndex = 0;

      while ((startIndex = lowerText.indexOf(phrase, startIndex)) !== -1) {
        const endIndex = startIndex + phrase.length;
        const originalPhrase = processedText.substring(startIndex, endIndex);
        const replacement = replacementMap.get(phrase);

        // Store replacement information
        replacements.push({
          start: currentPosition + startIndex,
          end: currentPosition + endIndex,
          original: originalPhrase,
          replacement: replacement
        });

        startIndex = endIndex;
      }
    }

    // Sort replacements by start position (reverse order)
    replacements.sort((a, b) => b.start - a.start);

    // Apply replacements with HTML markup
    for (const rep of replacements) {
      processedText =
        processedText.substring(0, rep.start) +
        `<span style="color: red;" title="${rep.original}">${rep.replacement}</span>` +
        processedText.substring(rep.end);
    }

    return {
      html: processedText,
      replacements: replacements
    };
  } catch (error) {
    console.error('Error applying medical replacements:', error);
    throw new Error(`Failed to apply medical replacements: ${error.message}`);
  }
}

async function getMedicalDictionary() {
  const ddbClient = new DynamoDBClient({
    region: process.env.REACT_APP_AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.REACT_APP_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.REACT_APP_AWS_SECRET_ACCESS_KEY
    }
  });

  const docClient = DynamoDBDocumentClient.from(ddbClient);

  try {
    const response = await docClient.send(new ScanCommand({
      TableName: "transcriber-medical",
      Select: "ALL_ATTRIBUTES"
    }));

    return response.Items || [];
  } catch (error) {
    console.error('Error fetching dictionary:', error);
    throw new Error(`Failed to fetch medical dictionary: ${error.message}`);
  }
}

function createReplacementMap(dictionary) {
  // Create a map of phrases to their display values
  const replacementMap = new Map();
  dictionary.forEach(entry => {
    if (entry.Phrase && entry.DisplayAs) {
      replacementMap.set(entry.Phrase.toLowerCase(), entry.DisplayAs);
    }
  });
  return replacementMap;
}

function processText(text, replacementMap) {
  let processedText = text;
  let replacements = [];
  let currentPosition = 0;

  // Sort phrases by length (longest first) to handle overlapping terms correctly
  const sortedPhrases = Array.from(replacementMap.keys()).sort((a, b) => b.length - a.length);

  for (const phrase of sortedPhrases) {
    const lowerText = processedText.toLowerCase();
    let startIndex = 0;

    while ((startIndex = lowerText.indexOf(phrase, startIndex)) !== -1) {
      const endIndex = startIndex + phrase.length;
      const originalPhrase = processedText.substring(startIndex, endIndex);
      const replacement = replacementMap.get(phrase);

      // Store replacement information
      replacements.push({
        start: currentPosition + startIndex,
        end: currentPosition + endIndex,
        original: originalPhrase,
        replacement: replacement
      });

      startIndex = endIndex;
    }
  }

  // Sort replacements by start position (reverse order)
  replacements.sort((a, b) => b.start - a.start);

  // Apply replacements with HTML markup
  let htmlText = text;
  for (const rep of replacements) {
    htmlText =
      htmlText.substring(0, rep.start) +
      `<span style="color: red;" title="${rep.original}">${rep.replacement}</span>` +
      htmlText.substring(rep.end);
  }

  return {
    html: htmlText,
    replacements: replacements
  };
}

// Helper function to save cleaned text to S3
async function saveCleanedText(sessionId, text) {
  const s3Client = new S3Client({
    region: process.env.REACT_APP_AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.REACT_APP_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.REACT_APP_AWS_SECRET_ACCESS_KEY
    }
  });

  try {
    // Process text with replacements
    const processedResult = await applyMedicalReplacements(text);

    // Save both the HTML and raw versions
    const data = {
      html: processedResult.html,
      raw: text,
      replacements: processedResult.replacements,
      timestamp: new Date().toISOString()
    };

    const command = new PutObjectCommand({
      Bucket: "ai.hadassah.frankfurt",
      Key: `clean-texts/${sessionId}.json`,
      Body: JSON.stringify(data),
      ContentType: 'application/json'
    });

    await s3Client.send(command);
    console.log('Successfully saved cleaned text to S3');

    return processedResult;
  } catch (error) {
    console.error('Error saving cleaned text:', error);
    throw new Error(`Failed to save cleaned text: ${error.message}`);
  }
}

export { saveCleanedText };

// Helper function to get AI instructions from S3
async function getAiInstructions() {
  const s3Client = new S3Client({
    region: process.env.REACT_APP_AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.REACT_APP_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.REACT_APP_AWS_SECRET_ACCESS_KEY
    }
  });

  try {
    const command = new GetObjectCommand({
      Bucket: "ai.hadassah.frankfurt",
      Key: "_config/ai-instructions.txt"
    });

    const response = await s3Client.send(command);
    if (!response.Body) throw new Error('No AI instructions found');

    const reader = response.Body.getReader();
    const decoder = new TextDecoder('utf-8');
    let result = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    
    return result.trim();
    
  } catch (error) {
    console.error('Error reading AI instructions:', error);
    throw new Error(`Failed to read AI instructions: ${error.message}`);
  }
}

// Helper function to get transcription from S3
async function getTranscriptionContent(sessionId) {
  const s3Client = new S3Client({
    region: process.env.REACT_APP_AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.REACT_APP_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.REACT_APP_AWS_SECRET_ACCESS_KEY
    }
  });

  try {
    console.log('Fetching transcription for session:', sessionId);
    
    const command = new GetObjectCommand({
      Bucket: "ai.hadassah.frankfurt",
      Key: `transcriptions/${sessionId}.json`
    });

    const response = await s3Client.send(command);
    if (!response.Body) throw new Error('No transcription found');

    const reader = response.Body.getReader();
    const decoder = new TextDecoder('utf-8');
    let result = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    
    console.log('Raw transcription data:', result);
    
    const transcriptionData = JSON.parse(result);
    let content = '';

    // Handle uploaded file transcription format
    if (transcriptionData.results?.transcripts) {
      content = transcriptionData.results.transcripts[0]?.transcript || '';
    }
    // Handle real-time transcription format
    else if (transcriptionData.content) {
      content = transcriptionData.content;
    }
    // Handle other potential formats or throw error
    else {
      console.error('Unexpected transcription format:', transcriptionData);
      throw new Error('Invalid transcription format');
    }

    console.log('Extracted content:', content);
    return content;
    
  } catch (error) {
    console.error('Error reading transcription:', error);
    throw new Error(`Failed to read transcription: ${error.message}`);
  }
}

// Update the aiAgentClean function to properly handle the content
export const aiAgentClean = async (sessionId, onProgress) => {
  if (!sessionId) {
    throw new Error('No session ID provided');
  }

  try {
    // Get both AI instructions and transcription content
    const [systemPrompt, transcriptionContent] = await Promise.all([
      getAiInstructions(),
      getTranscriptionContent(sessionId)
    ]);
    
    if (!transcriptionContent) {
      throw new Error('No transcription content found');
    }

    console.log('Initializing Bedrock client...');
    
    const bedrockClient = new BedrockRuntimeClient({
      region: process.env.REACT_APP_AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.REACT_APP_AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.REACT_APP_AWS_SECRET_ACCESS_KEY
      }
    });

    const requestBody = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 3000,
      temperature: 0,
      system: ".התפקיד שלך לנקות את הטקסט ולשמור עליו כמו שהוא בצורה הגולמית שלו, אל תוסיף הקדמה בהתחה וסיכום סוף. הדבר שצרי לשנות:1. סימני פיסוק לדוגמא נקודותיים יוחלף ל :. 2.מספרים נומרים כשאפשר לדוגמא: חמישים יוחלף ל50",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: transcriptionContent }]
        }
      ]
    };

    const command = new InvokeModelWithResponseStreamCommand({
      modelId: "anthropic.claude-3-sonnet-20240229-v1:0",
      body: JSON.stringify(requestBody),
      contentType: "application/json",
      accept: "application/json",
    });

    const response = await bedrockClient.send(command);
    let fullResponse = '';

    try {
      for await (const chunk of response.body) {
        const decoder = new TextDecoder();
        const chunkText = decoder.decode(chunk.chunk.bytes);
        const parsedChunk = JSON.parse(chunkText);

        if (parsedChunk.type === 'content_block_delta') {
          const deltaText = parsedChunk.delta.text;
          fullResponse += deltaText;

          // Call the progress callback with the accumulated text
          if (onProgress) {
            onProgress(fullResponse);
          }
        }
      }

      console.log('Cleaning completed, applying medical replacements...');

      // Apply medical term replacements to the cleaned text
      const processedResult = await applyMedicalReplacements(fullResponse);

      // Save the processed text to S3
      await saveCleanedText(sessionId, fullResponse);

      // Update the progress with the final processed HTML
      if (onProgress) {
        onProgress(processedResult.html);
      }

      return processedResult.html;
      
    } catch (streamError) {
      console.error('Error processing stream:', streamError);
      throw new Error(`Stream processing error: ${streamError.message}`);
    }
    
  } catch (error) {
    console.error('AI processing error:', error);
    throw new Error(`Failed to process text: ${error.message}`);
  }
};

async function getCleanedText(sessionId) {
  const s3Client = new S3Client({
    region: process.env.REACT_APP_AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.REACT_APP_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.REACT_APP_AWS_SECRET_ACCESS_KEY
    }
  });

  try {
    console.log('Fetching cleaned text for session:', sessionId);
    
    const command = new GetObjectCommand({
      Bucket: "ai.hadassah.frankfurt",
      Key: `clean-texts/${sessionId}.json`
    });

    const response = await s3Client.send(command);
    if (!response.Body) throw new Error('No cleaned text found');

    const reader = response.Body.getReader();
    const decoder = new TextDecoder('utf-8');
    let result = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    
    console.log('Successfully fetched cleaned text');
    return result;
    
  } catch (error) {
    console.error('Error reading cleaned text:', error);
    throw new Error(`Failed to read cleaned text: ${error.message}`);
  }
}

export const aiAgentSummary = async (sessionId, onProgress) => {
  if (!sessionId) {
    throw new Error('No session ID provided');
  }

  try {
    let textToSummarize;
    
    // Try to get cleaned text first
    try {
      const cleanedText = await getCleanedText(sessionId);
      const parsedText = JSON.parse(cleanedText);
      textToSummarize = parsedText.raw || parsedText.html;
    } catch (error) {
      console.log('Cleaned text not found, falling back to original transcription');
      // If cleaned text isn't available, get original transcription
      textToSummarize = await getTranscriptionContent(sessionId);
    }

    if (!textToSummarize) {
      throw new Error('No text content found to summarize');
    }
    
    console.log('Initializing Bedrock client for summary...');
    
    const bedrockClient = new BedrockRuntimeClient({
      region: process.env.REACT_APP_AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.REACT_APP_AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.REACT_APP_AWS_SECRET_ACCESS_KEY
      }
    });

    const systemPrompt = `You are a medical transcription assistant tasked with creating concise, accurate summaries of medical conversations.
    Your summaries should:
    1. Maintain all relevant medical information
    2. Organize information logically
    3. Use clear, professional language
    4. Preserve any specific numbers, measurements, or dosages
    5. Include key patient complaints, symptoms, and diagnoses
    6. Highlight any important actions or follow-ups
    7. Answer in detected language

    Format the summary with appropriate headers and bullet points when relevant.
    Keep medical terminology intact but provide clear context.`;

    const requestBody = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 3000,
      temperature: 0,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Please provide a clear, structured summary of this medical conversation: \n\n${textToSummarize}`
            }
          ]
        }
      ]
    };

    console.log('Sending summary request to Bedrock...');

    const command = new InvokeModelWithResponseStreamCommand({
      modelId: "anthropic.claude-3-sonnet-20240229-v1:0",
      body: JSON.stringify(requestBody),
      contentType: "application/json",
      accept: "application/json",
    });

    const response = await bedrockClient.send(command);
    let fullResponse = '';
    
    try {
      for await (const chunk of response.body) {
        const decoder = new TextDecoder();
        const chunkText = decoder.decode(chunk.chunk.bytes);
        const parsedChunk = JSON.parse(chunkText);
        
        if (parsedChunk.type === 'content_block_delta') {
          const deltaText = parsedChunk.delta.text;
          fullResponse += deltaText;
          
          if (onProgress) {
            onProgress(fullResponse);
          }
        }
      }
      
      console.log('Summary generation completed successfully');
      
      // Save the summary to S3
      const summaryData = {
        sessionId,
        timestamp: new Date().toISOString(),
        summary: fullResponse,
        originalText: textToSummarize
      };

      await saveToS3(
        'ai.hadassah.frankfurt',
        `ai-summaries/${sessionId}.json`,
        JSON.stringify(summaryData, null, 2),
        'application/json'
      );
      
      return fullResponse;
      
    } catch (streamError) {
      console.error('Error processing summary stream:', streamError);
      throw new Error(`Stream processing error: ${streamError.message}`);
    }
    
  } catch (error) {
    console.error('AI summary error:', error);
    throw new Error(`Failed to generate summary: ${error.message}`);
  }
};

// Helper function to save to S3
async function saveToS3(bucket, key, data, contentType) {
  const s3Client = new S3Client({
    region: process.env.REACT_APP_AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.REACT_APP_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.REACT_APP_AWS_SECRET_ACCESS_KEY
    }
  });

  try {
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: data,
      ContentType: contentType
    });

    await s3Client.send(command);
    console.log(`Successfully saved to S3: ${key}`);
  } catch (error) {
    console.error('Error saving to S3:', error);
    throw new Error(`Failed to save to S3: ${error.message}`);
  }
}
