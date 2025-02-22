import OpenAI from "openai"
import getLanguage from "./language-map"
import { DEFAULT_CONTEXT } from "./context"
import * as fs from "fs"
import * as path from "path"

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

/**
 * The updates file structure.
 *
 * @field insert the string of new terms to translate and insert into the different files, this is a required parameter
 * @field delete the string of old terms to be removed from all the translation files, this is a required parameter
 * @field langDir the directory holding all language files, defaulting to context.langDir
 * @field languages override the automatic search of valid languages to insert own string of languages to translate into (e.g. "Dutch", "Italian", ...)
 * @field validatedLanguages a list of ISO639-1 two-letter code names of all validated languages, defaulting to context.validatedLanguages
 * @field baseLanguage the ISO639-1 two-letter base language code name (i.e., "en") of the company, defaulting to context.baseLanguage
 * @field model the OpenAI LLM model to use (i.e., "gpt-4o"), defaulting to context.model
 * @field modelTemperature the temperature of the LLM model (the lower the temperature, the more deterministic the model), defaults to 0.1 unless specified
 */
interface Updates {
    insert: string[]
    delete: string[]
    langDir?: string
    languages?: string[]
    validatedLanguages?: string[]
    baseLanguage?: string
    model?: string
    modelTemperature?: number
    fillerWord?: boolean
}

/**
 * Stores the file path, language code, and language name of all valid language files within cwd.
 */
interface FileStructure {
    path: string
    code: string
    name: string
}

/**
 * The expected response format => {language: {term: {value: string, flagged: boolean}, ...}, ...}
 */
interface TranslationResponse {
    [language: string]: {
        [term: string]: {
            value: string
            flagged: boolean
        }
    }
}

/**
 * Get an array of FileStructure objects indicating the path, name and language code of all
 * valid files to be updated found in cwd, except the base language file.
 *
 * @param updates the provided update options in this request
 */
const getValidLanguageFiles = (updates: Updates): FileStructure[] => {
    const cwd = updates.langDir || DEFAULT_CONTEXT.langDir
    const baseLanguage = updates.baseLanguage || DEFAULT_CONTEXT.baseLanguage
    const files = fs.readdirSync(cwd)
    const validFiles: FileStructure[] = []

    for (const file of files) {
        const ext = path.extname(file).toLowerCase()
        const bareFileName = path.basename(file, ext).toLowerCase()

        // Only process .json files
        if (ext === ".json" && bareFileName !== baseLanguage && getLanguage(bareFileName)) {
            // If a specific list of languages is provided, only add files that are also present in the list
            if (
                updates.languages &&
                updates.languages.length > 0 &&
                !updates.languages.includes(getLanguage(bareFileName))
            ) {
                continue
            }

            validFiles.push({
                path: path.join(cwd, file),
                code: bareFileName,
                name: getLanguage(bareFileName),
            })
        }
    }

    return validFiles
}

/**
 * This method formats the user prompt as a string for the LLM model, using the desired input terms
 * and target languages.
 *
 * @param updates the provided update options
 *
 * @return the user prompt as a string
 */
const createUserPrompt = (updates: Updates): string => {
    const targetLanguageFiles = getValidLanguageFiles(updates)

    const requestedChanges = {
        terms: updates.insert,
        languages: updates.languages || [],
    }

    // If no specific file paths are specified, use the detected files in the indicated cwd
    if (requestedChanges.languages.length == 0) {
        for (const file of targetLanguageFiles) {
            requestedChanges.languages.push(file.name)
        }
    }

    return `${JSON.stringify(requestedChanges, null, 2)}`
}

/**
 * The method creates a system prompt for the model to use, detailing the response format and
 * incorporating the provided company name and descriptions for a more tailored request.
 *
 * Some translation examples will be included from any validated language indicated through
 * the update parameter or otherwise found in the default context file, if any.
 *
 * @param updates the provided update options
 *
 * @return the system prompt as a string
 */
const createSystemPrompt = (updates: Updates): string => {
    const allLanguageFiles = getValidLanguageFiles(updates)
    const validatedLanguageFiles: FileStructure[] = []
    const validatedLanguageCodes: string[] = updates.validatedLanguages || DEFAULT_CONTEXT.validatedLanguages
    for (const file of allLanguageFiles) {
        if (validatedLanguageCodes.includes(file.code)) {
            validatedLanguageFiles.push(file)
        }
    }
    let prompt = "You are a translation assistant"

    if (!DEFAULT_CONTEXT.companyName) {
        prompt += "."
    } else {
        prompt += ` who works for a company called ${DEFAULT_CONTEXT.companyName}.`
    }

    if (!DEFAULT_CONTEXT.companyDescription) {
        prompt += "\n"
    } else {
        prompt += ` ${DEFAULT_CONTEXT.companyDescription}\n\n`
    }

    prompt += `You will receive a list of terms that need to be translated in different languages. The request will be formatted as follows:
{
    terms: string[],
    languages: string[]
}

You must provide a translation in JSON of each term for every indicated language and format your JSON response for each language as follows:
{
    language: {
        term: {
            value: string,
            flagged: boolean
        }, ...
    }, ...
}

Each term will be shown in different places of the company's web application, therefore, you MUST take into consideration the context where it operates for an accurate translation of each term.
Each translated value should present your best translation for the given term in the target language. Set the 'flagged' property to true if you are unsure about this translation and it requires further validation. 
Ensure translations are consistent and take into consideration the context where the term is used and the cultural context of the target language.`

    if (updates.fillerWord) {
        prompt += `\nYour translations need to take into account that the string '%s' is occasionally used as a placeholder to inject content dynamically, and must be placed appropriately according to the target language sentence structure.`
    }

    prompt += `\nMost languages will use informal speech on websites, though for some languages (especially eastern european and baltic languages) it is appropriate to use formal speech. You must decide what is most appropriate and be consistent with this approach for the target language.
Not all terms may have a proper translation as some languages use English terms for tech terms.
For every language, the amount of translated terms in your JSON response must match the amount of terms given in the request.

For example, with the following request:
{
    terms: ["Dashboard", "Payment successful!"],
    languages: ["Italian", "Dutch", "Russian"]
}

You will need to output the following JSON response:
{
    "Italian": {
        "Dashboard": {
            value: "Dashboard",
            flagged: false
        },
        "Payment Successful!": {
            value: "Pagamento Riuscito!",
            flagged: false
        }
    },
    "Dutch": {
        "Dashboard": {
            value: "Dashboard",
            flagged: false
        },
        "Payment Successful!": {
            value: "Betaling Geslaagd!",
            flagged: false
        }
    },
    "Russian": {
        "Dashboard": {
            value: "Главная",
            flagged: false
        },
        "Payment Successful!": {
            value: "Оплата прошла успешно!",
            flagged: false
        }
    }
}`

    if (validatedLanguageFiles.length > 0) {
        //Store the first randomly picked terms so tha same translations are provided for all languages
        const chosenTerms: string[] = []
        prompt += `\n\nHere are some translation in different verified languages used in the web application to give you more context:\n`

        // Add random entries from each validated file
        for (const file of validatedLanguageFiles) {
            const fileContent = JSON.parse(fs.readFileSync(file.path, "utf-8")) as Record<string, string>
            const entries = Object.entries(fileContent)
            const sampleEntries = getEntries(entries, chosenTerms)

            prompt += `\nFrom ${file.name}:\n`
            for (const [term, value] of sampleEntries) {
                prompt += `  ${term}: ${value}\n`
            }
        }
    }

    return prompt
}

/**
 * Helper function to get entries from an array of [term: string, value: string] pairs.
 * If no specific keys are indicated, random entries will be retrieved.
 *
 * @param entries The array of key-value entries to sample from
 * @param chosenTerms The chosen terms to translate, if any
 * @param count The number of random entries to return, defaulting to 20 per language
 *
 * @returns An array of [term: string, value: string] entries
 */
const getEntries = (entries: [string, string][], chosenTerms: string[], count: number = 20): [string, string][] => {
    // If this is the first language then randomly pick entries
    if (chosenTerms.length == 0) {
        const shuffled = entries.sort(() => 0.5 - Math.random())
        const res = shuffled.slice(0, count)

        for (const entry of shuffled.slice(0, count)) {
            chosenTerms.push(entry[0])
        }

        return res
    }

    const res: [string, string][] = []
    for (const entry of entries) {
        if (chosenTerms.includes(entry[0])) {
            res.push(entry)
        }
    }
    return res
}

/**
 * Function used to delete indicated terms in the provided update options from the indicated files.
 *
 * @param updates the provided update options
 * @param files the language files to be updated
 */
const deleteTerms = (updates: Updates, files: FileStructure[]): void => {
    for (const file of files) {
        try {
            const fileContent = JSON.parse(fs.readFileSync(file.path, "utf-8"))
            let modified = false
            // Remove the specified terms
            for (const term of updates.delete) {
                if (Object.prototype.hasOwnProperty.call(fileContent, term)) {
                    delete fileContent[term]
                    modified = true
                }
            }

            if (modified) {
                // Write the updated content back to the file
                fs.writeFileSync(file.path, JSON.stringify(fileContent, null, 2), "utf-8")
            }
        } catch (error) {
            console.error(`Error deleting from file ${file}: ${error.message}`)
        }
    }
}

/**
 * Create the system and user prompt to be used by the LLM Model to perform the requested updates.
 * Return the model response as a TranslationResponse object.
 *
 * @param updates the provided update options
 *
 * @return the TranslationResponse object returned by the model, null if no values were provided to insert or if an error occurred during the API call
 */
const translate = async (updates: Updates): Promise<TranslationResponse | null> => {
    if (updates.insert.length == 0) {
        console.error("Aborting API Call: No insert values provided.")
        return null
    }

    const model = updates.model || DEFAULT_CONTEXT.model || "gpt-4o"
    const systemPrompt = createSystemPrompt(updates)
    const userPrompt = createUserPrompt(updates)

    try {
        const response = await client.chat.completions.create({
            model: model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
            ],
            temperature: updates.modelTemperature || 0.1, //Defaults to 0.1 unless specified
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0,
            response_format: {
                type: "json_object",
            },
        })

        const translatedContent = response.choices[0].message.content

        let translatedData: TranslationResponse = {}
        if (translatedContent != null) {
            translatedData = JSON.parse(translatedContent)
        }
        return translatedData
    } catch (error) {
        console.error("Error in API call:", error)
        return null
    }
}

/**
 * Checks that the keys for the given translations match the originally given terms.
 * @param translatedLanguageData the TranslationResponse only containing this language translations
 * @param updates the provided update options
 */
const validateKeys = (translatedLanguageData, updates: Updates): void => {
    const baseKeys = new Set(updates.insert)
    const translatedKeys = new Set(Object.keys(translatedLanguageData))

    const missingKeys = [...baseKeys].filter(key => !translatedKeys.has(key))
    const extraKeys = [...translatedKeys].filter(key => !baseKeys.has(key))

    if (missingKeys.length > 0 || extraKeys.length > 0) {
        throw new Error(`Found key mismatch:\n
            Missing Keys: ${missingKeys}\n
            Extra Keys: ${extraKeys}`)
    }
}

/**
 * Given the requested updates, the method finds all the valid language file paths, deletes
 * the indicated terms from each file, and adds the requested translations as retrieved by the
 * model. Metadata is added for flagged translations.
 *
 * @param updates the provided update options
 */
const main = (updates: Updates) => {
    if (updates.fillerWord === undefined) {
        // Indicates that terms in the language files may contain the placeholder '%s'
        updates.fillerWord = true
    }

    // 1. Find all valid files in cwd
    const languageFilePaths = getValidLanguageFiles(updates)
    // 2. Delete all the terms requested by the user
    deleteTerms(updates, languageFilePaths)
    // 3. Send OpenAI the translation update request and retrieve the result
    translate(updates).then(translatedData => {
        if (translatedData) {
            // 4. For each languageFilePath append the new translations retrieved in translatedData, whose language matches the file's name
            for (const file of languageFilePaths) {
                try {
                    // Filter translations specific to this language
                    const translations = translatedData[file.name]
                    validateKeys(translations, updates)

                    // Extract terms as key-value pairs to append
                    const currentContent: Record<string, string> = JSON.parse(fs.readFileSync(file.path, "utf-8"))
                    const toAdd: Record<string, string> = {}
                    const flagged = {}
                    for (const term of Object.keys(translations)) {
                        toAdd[term] = translations[term].value

                        if (translations[term].flagged) {
                            flagged[term] = translations[term]
                        }
                    }

                    const updatedContent: Record<string, string> = { ...currentContent, ...toAdd }
                    // Write the updated content back to the file
                    fs.writeFileSync(file.path, JSON.stringify(updatedContent, null, 2), "utf-8")

                    //Handle flagged translation
                    if (Object.keys(flagged).length > 0) {
                        const metaFilePath = `${updates.langDir || DEFAULT_CONTEXT.langDir}${file.code}-meta.json`

                        let metaContent = {}
                        if (fs.existsSync(metaFilePath)) {
                            metaContent = JSON.parse(fs.readFileSync(metaFilePath, "utf-8"))
                        }

                        // Append flagged translations to the metadata file
                        for (const [term, translation] of Object.entries(flagged)) {
                            metaContent[term] = translation
                        }

                        // Write updated metadata content to the file
                        fs.writeFileSync(metaFilePath, JSON.stringify(metaContent, null, 2), "utf-8")
                    }
                } catch (error) {
                    console.error(`Error updating file ${file.path}: ${error.message}`)
                }
            }
        } else {
            console.log("Translation empty or failed.")
        }
    })
}

//Example Usage:
main({
    insert: [],
    delete: [],
})
