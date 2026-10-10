# Garageportexperten Portservice – installationsstatus

Detta är ett **fristående** projekt, helt utan koppling till ViltIQ.

## Status 2026-10-10
- GitHub: eget repository med webbappens HTML, JavaScript, CSS, 325 kontrollpunkter, appikon, manifest och config.
- Supabase: eget projekt `qpkxlbxcwezibsomjmce` i organisation `garageportexperten-portservice.`.
- Egen databas installerad: kunder, objekt, montörer, serviceuppdrag, kontrollsvar, öppna brister, ändringshistorik.
- Sparade startposter: fem montörer, Palladium Fastigheter AB och fyra Hörmann SPU 40 / A445.
- Öppet testläge, utan inloggning, på användarens uttryckliga begäran.
- PDF-generering finns i appen; mejlutskick till kunden är tills vidare avstängda.
- Push/mejlpåminnelser inte driftsatta; 10-dagarsöversikt finns.

## Publicera med GitHub Pages
1. Öppna repositoryts **Settings → Pages**.
2. Under **Build and deployment** välj **Deploy from a branch**.
3. Välj **main** och **/(root)**, tryck **Save**.
4. Öppna adressen som GitHub Pages visar.

## Dataskydd i det öppna testläget
Alla som hittar/lär sig webbadressen kan läsa och redigera testuppgifter. Det finns inga publika raderingspolicyer, och tabelländringar loggas.
Det är ändå **inte** ett säkert produktionssystem eller en garanti mot manipulerade uppgifter.

## Viktigt inför uppdateringar
Radera aldrig befintliga tabeller, servicehistorik eller testdata. Gör alltid en ny migrering för schemaförändringar. Koden och databasen ska fortsätta vara skilda från alla andra projekt.
