# Processus en arrière-plan et relais MCP — v0.27.1

Le studio Windows comporte une interface et plusieurs processus WebView2 pour le rendu, le GPU, l’audio ou le réseau. Les traitements peuvent lancer temporairement Python, FFmpeg ou un moteur local. Un lot de doublage conserve son moteur chargé jusqu’à la fin ou l’annulation.

Une longue liste de petits processus **AI Dubbing Studio** distincts de WebView2 peut aussi provenir des relais MCP. Le relais utilise le même exécutable que l’interface, avec l’argument `--mcp`, et n’ouvre aucune fenêtre. Le nom seul dans le Gestionnaire des tâches ne permet pas de déterminer son rôle.

## Accumulation reproduite

Le transport SSH installé pour le contrôle distant utilise un canal par requête afin de contourner la mise en tampon rencontrée avec OpenSSH sous Windows. Il ferme ensuite son entrée. Si le relais distant ne reçoit pas la fin du flux, il peut continuer à attendre alors que sa réponse a déjà été reçue et que le studio reste ouvert.

Le diagnostic isolé avec l’exécutable v0.27.0 reproduit **six réponses suivies de six relais encore présents**, en gardant volontairement les entrées ouvertes. Cela reproduit un mécanisme d’accumulation ; l’identité des processus d’un PC donné doit être confirmée par leurs arguments ou le rapport de diagnostic. Aucun projet personnel n’est utilisé pour ce test.

## Correction

Le [transport SSH livré avec les sources](../scripts/mcp-ssh-stdio.mjs) envoie désormais une notification privée de transport **dans la première écriture**, avant l’initialisation MCP :

```json
{"jsonrpc":"2.0","method":"notifications/studio/one-shot","params":{"requestId":"identifiant-de-la-requete"}}
```

Le relais v0.27.1 attend la réponse portant exactement cet identifiant, la termine et la vide vers la sortie, puis quitte de lui-même sans attendre la fermeture de son entrée. Cela fonctionne aussi pour les réponses d’erreur et les appels asynchrones. Les tâches déjà acceptées appartiennent au studio et continuent après la fin du canal ; fermer un relais ne correspond pas à annuler leur identifiant de traitement.

Ce mode est explicite : un client MCP classique reste connecté pendant les périodes d’inactivité. Aucun délai d’inactivité global n’est ajouté. Le mode ponctuel possède une limite de 210 secondes pour éviter une attente indéfinie, notamment si la sortie ne peut plus être vidée. Les protections existantes à l’arrêt du studio, à la désactivation de MCP et au changement de session sont conservées. Une erreur d’écriture de la sortie termine également le relais.

**La correction nécessite le studio v0.27.1 et le transport SSH mis à jour.** Modifier seulement l’un des deux ne corrige pas tous les cas. Le transport demeure compatible avec les anciennes versions, qui ignorent cette notification et continuent à utiliser la fermeture habituelle du flux.

Le script accepte le chemin de la configuration SSH comme premier argument. Cette configuration contient `command`, `args` et, si nécessaire, `env`, comme dans la configuration existante. Il utilise la clé SSH restreinte déjà autorisée ; aucun accès de commande distante supplémentaire n’est requis. Les appels et les résultats du studio sont transmis sans réécriture de leur contenu.

## Nettoyer les anciens relais

Dans les paramètres du studio, désactivez **Activer le pilotage MCP local**, puis attendez quelques secondes. Les relais récents surveillent le serveur et quittent lorsqu’il s’arrête. Fermez ensuite normalement le studio avant l’installation. Après installation, réactivez MCP et reconnectez le client IA. Les anciens projets et essais restent disponibles.

Le rapport de diagnostic en lecture seule sépare l’interface, les relais `--mcp`, les processus WebView2 et les moteurs. Il n’enregistre pas les lignes de commande, jetons ou contenus des projets. Un processus dont le parent est absent constitue un indice, pas une preuve suffisante de fuite.

## Validation

Les régressions de processus vérifient les entrées maintenues ouvertes, vingt requêtes successives sans relais restant, la réponse différée complète, les erreurs RPC et la persistance des clients habituels. Un pont de test reproduit aussi l’absence d’EOF du transport SSH et utilise le SDK MCP officiel. Ces tests emploient de vrais processus du relais Windows et un serveur de test privé ; ils ne constituent pas une mesure du réseau du PC RTX. L’application Windows empaquetée vérifie séparément le même pont face au véritable studio ouvert dans une session isolée.

La publication de maintenance vérifie que les workers, poids référencés, dépendances des moteurs et catalogue MCP sont identiques à v0.27.0. Elle refait les suites Windows et les tests natifs du bureau ; elle ne refait pas les longues générations neuronales inchangées. Les réglages de qualité et les vumètres v0.27.0 sont conservés.

Pour appliquer une réverbération, un écho ou un autre effet à un essai existant : voir [Effets audio sur les doublages](AUDIO-EFFECTS.md#effets-sur-une-réplique).
