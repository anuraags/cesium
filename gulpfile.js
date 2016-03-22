/*jslint node: true, latedef: nofunc*/
'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');
var child_process = require('child_process');
var crypto = require('crypto');
var zlib = require('zlib');
var readline = require('readline');

var globby = require('globby');
var jshint = require('gulp-jshint');
var async = require('async');
var rimraf = require('rimraf');
var stripComments = require('strip-comments');
var mkdirp = require('mkdirp');
var eventStream = require('event-stream');
var gulp = require('gulp');
var gulpInsert = require('gulp-insert');
var gulpZip = require('gulp-zip');
var gulpRename = require('gulp-rename');
var gulpReplace = require('gulp-replace');
var Promise = require('bluebird');
var requirejs = require('requirejs');
var karma = require('karma').Server;
var yargs = require('yargs');
var aws = require('aws-sdk-promise');
var mime = require('mime');
var compressible = require('compressible');

var packageJson = require('./package.json');
var version = packageJson.version;
if (/\.0$/.test(version)) {
    version = version.substring(0, version.length - 2);
}

var karmaConfigFile = path.join(__dirname, 'Specs/karma.conf.js');

//Gulp doesn't seem to have a way to get the currently running tasks for setting
//per-task variables.  We use the command line argument here to detect which task is being run.
var taskName = process.argv[2];
var noDevelopmentGallery = taskName === 'release' || taskName === 'makeZipFile';
var buildingRelease = noDevelopmentGallery;
var minifyShaders = taskName === 'minify' || taskName === 'minifyRelease' || taskName === 'release' || taskName === 'makeZipFile' || taskName === 'buildApps';

//travis reports 32 cores but only has 3GB of memory, which causes the VM to run out.  Limit to 8 cores instead.
var concurrency = Math.min(os.cpus().length, 8);

//Since combine and minify run in parallel already, split concurrency in half when building both.
//This can go away when gulp 4 comes out because it allows for synchronous tasks.
if (buildingRelease) {
    concurrency = concurrency / 2;
}

var sourceFiles = ['Source/**/*.js',
                   '!Source/*.js',
                   '!Source/Workers/**',
                   '!Source/ThirdParty/Workers/**',
                   'Source/Workers/createTaskProcessorWorker.js'];

var buildFiles = ['Specs/**/*.js',
                  '!Specs/SpecList.js',
                  'Source/Shaders/**/*.glsl'];

var jsHintFiles = ['Source/**/*.js',
                   '!Source/Shaders/**',
                   '!Source/ThirdParty/**',
                   '!Source/Workers/cesiumWorkerBootstrapper.js',
                   'Apps/**/*.js',
                   'Apps/Sandcastle/gallery/*.html',
                   '!Apps/Sandcastle/ThirdParty/**',
                   'Specs/**/*.js',
                   'Tools/buildTasks/**/*.js',
                   'gulpfile.js'];

var filesToClean = ['Source/Cesium.js',
                    'Build',
                    'Instrumented',
                    'Source/Shaders/**/*.js',
                    'Specs/SpecList.js',
                    'Apps/Sandcastle/jsHintOptions.js',
                    'Apps/Sandcastle/gallery/gallery-index.js',
                    'Cesium-*.zip'];

var filesToSortRequires = ['Source/**/*.js',
                           '!Source/Shaders/**',
                           '!Source/ThirdParty/**',
                           '!Source/Workers/cesiumWorkerBootstrapper.js',
                           '!Source/copyrightHeader.js',
                           '!Source/Workers/transferTypedArrayTest.js',
                           'Apps/**/*.js',
                           '!Apps/Sandcastle/ThirdParty/**',
                           '!Apps/Sandcastle/jsHintOptions.js',
                           'Specs/**/*.js',
                           '!Specs/spec-main.js',
                           '!Specs/SpecRunner.js',
                           '!Specs/SpecList.js',
                           '!Apps/Sandcastle/Sandcastle-client.js',
                           '!Apps/Sandcastle/Sandcastle-header.js',
                           '!Apps/Sandcastle/Sandcastle-warn.js',
                           '!Apps/Sandcastle/gallery/gallery-index.js'];

gulp.task('default', ['combine']);

gulp.task('build', function(done) {
    mkdirp.sync('Build');
    glslToJavaScript(minifyShaders, 'Build/minifyShaders.state');
    createCesiumJs();
    createSpecList();
    createGalleryList();
    createJsHintOptions();
    done();
});

gulp.task('build-watch', function() {
    gulp.watch(buildFiles, ['build']);
});

gulp.task('buildApps', function() {
    return buildCesiumViewer();
});

gulp.task('clean', function(done) {
    async.forEach(filesToClean, rimraf, done);
});

gulp.task('requirejs', function(done) {
    var config = JSON.parse(new Buffer(process.argv[3].substring(2), 'base64').toString('utf8'));
    requirejs.optimize(config, function() {
        done();
    }, done);
});

gulp.task('cloc', ['build'], function() {
    var cmdLine;
    var clocPath = path.join('Tools', 'cloc-1.60', 'cloc-1.60.pl');
    var cloc_definitions = path.join('Tools', 'cloc-1.60', 'cloc_definitions');

    //Run cloc on primary Source files only
    var source = new Promise(function(resolve, reject) {
        var glsl = globby.sync(['Source/Shaders/*.glsl', 'Source/Shaders/**/*.glsl']).join(' ');

        cmdLine = 'perl ' + clocPath + ' --quiet --progress-rate=0 --read-lang-def=' + cloc_definitions +
                  ' Source/main.js Source/Core/ Source/DataSources/ Source/Renderer/ Source/Scene/ Source/Widgets/ Source/Workers/ ' + glsl;

        child_process.exec(cmdLine, function(error, stdout, stderr) {
            if (error) {
                console.log(stderr);
                return reject(error);
            }
            console.log('Source:');
            console.log(stdout);
            resolve();
        });
    });

    //If running cloc on source succeeded, also run it on the tests.
    return source.then(function() {
        return new Promise(function(resolve, reject) {
            cmdLine = 'perl ' + clocPath + ' --quiet --progress-rate=0 --read-lang-def=' + cloc_definitions + ' Specs/';
            child_process.exec(cmdLine, function(error, stdout, stderr) {
                if (error) {
                    console.log(stderr);
                    return reject(error);
                }
                console.log('Specs:');
                console.log(stdout);
                resolve();
            });
        });
    });
});

gulp.task('combine', ['generateStubs'], function() {
    var outputDirectory = path.join('Build', 'CesiumUnminified');
    return combineJavaScript({
        removePragmas : false,
        optimizer : 'none',
        outputDirectory : outputDirectory
    });
});

gulp.task('combineRelease', ['generateStubs'], function() {
    var outputDirectory = path.join('Build', 'CesiumUnminified');
    return combineJavaScript({
        removePragmas : true,
        optimizer : 'none',
        outputDirectory : outputDirectory
    });
});

//Builds the documentation
gulp.task('generateDocumentation', function() {
    var envPathSeperator = os.platform() === 'win32' ? ';' : ':';

    return new Promise(function(resolve, reject) {
        child_process.exec('jsdoc --configure Tools/jsdoc/conf.json', {
            env : {
                PATH : process.env.PATH + envPathSeperator + 'node_modules/.bin',
                CESIUM_VERSION : version
            }
        }, function(error, stdout, stderr) {
            if (error) {
                console.log(stderr);
                return reject(error);
            }
            console.log(stdout);
            var stream = gulp.src('Documentation/Images/**').pipe(gulp.dest('Build/Documentation/Images'));
            return streamToPromise(stream).then(resolve);
        });
    });
});

gulp.task('instrumentForCoverage', ['build'], function(done) {
    var jscoveragePath = path.join('Tools', 'jscoverage-0.5.1', 'jscoverage.exe');
    var cmdLine = jscoveragePath + ' Source Instrumented --no-instrument=./ThirdParty';
    child_process.exec(cmdLine, function(error, stdout, stderr) {
        if (error) {
            console.log(stderr);
            return done(error);
        }
        console.log(stdout);
        done();
    });
});

gulp.task('jsHint', ['build'], function() {
    var stream = gulp.src(jsHintFiles)
        .pipe(jshint.extract('auto'))
        .pipe(jshint())
        .pipe(jshint.reporter('jshint-stylish'));

    if (yargs.argv.failTaskOnError) {
        stream = stream.pipe(jshint.reporter('fail'));
    }
    return stream;
});

gulp.task('jsHint-watch', function() {
    gulp.watch(jsHintFiles).on('change', function(event) {
        gulp.src(event.path)
            .pipe(jshint.extract('auto'))
            .pipe(jshint())
            .pipe(jshint.reporter('jshint-stylish'));
    });
});

gulp.task('makeZipFile', ['release'], function() {
    //For now we regenerate the JS glsl to force it to be unminified in the release zip
    //See https://github.com/AnalyticalGraphicsInc/cesium/pull/3106#discussion_r42793558 for discussion.
    glslToJavaScript(false, 'Build/minifyShaders.state');

    var builtSrc = gulp.src([
        'Build/Apps/**',
        'Build/Cesium/**',
        'Build/CesiumUnminified/**',
        'Build/Documentation/**'
    ], {
        base : '.'
    });

    var staticSrc = gulp.src([
        'Apps/**',
        '!Apps/Sandcastle/gallery/development/**',
        'Source/**',
        'Specs/**',
        'ThirdParty/**',
        'logo.png',
        'favicon.ico',
        'gulpfile.js',
        'server.js',
        'package.json',
        'LICENSE.md',
        'CHANGES.md',
        'README.md',
        'web.config'
    ], {
        base : '.',
        nodir : true
    });

    var indexSrc = gulp.src('index.release.html').pipe(gulpRename("index.html"));

    return eventStream.merge(builtSrc, staticSrc, indexSrc)
        .pipe(gulpZip('Cesium-' + version + '.zip'))
        .pipe(gulp.dest('.'));
});

gulp.task('minify', ['generateStubs'], function() {
    return combineJavaScript({
        removePragmas : false,
        optimizer : 'uglify2',
        outputDirectory : path.join('Build', 'Cesium')
    });
});

gulp.task('minifyRelease', ['generateStubs'], function() {
    return combineJavaScript({
        removePragmas : true,
        optimizer : 'uglify2',
        outputDirectory : path.join('Build', 'Cesium')
    });
});

gulp.task('deploy', function(done) {
    var argv = yargs.usage('Usage: delpoy -b [Bucket Name] -d [Upload Directory]')
        .demand(['b', 'd']).argv;

    var uploadDirectory = argv.d;
    var bucketName = argv.b;

    var iface = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    iface.question('Files from your computer will be published to the ' + bucketName + ' bucket. Continue? [y/n] ', function (answer) {
        if (answer === 'y') {
            deployCesium(bucketName, uploadDirectory).then(function() {
                done();
            });
        } else {
            console.log('Deploy aborted by user.');
            done();
        }
    });
});

// Deploy cesium to aws
function deployCesium(bucketName, uploadDirectory) {
    var readFile = Promise.promisify(fs.readFile);
    var gzip = Promise.promisify(zlib.gzip);
    var concurrencyLimit = 2000;
    var cacheControl = "max-age=3600";

    var s3 = new aws.S3({
        maxRetries : 10,
        retryDelayOptions : {
            base : 500
        }
    });

    var existingBlobs = [];
    var totalFiles = 0;
    var uploaded = 0;
    var skipped = 0;

    return listAll(s3, bucketName, uploadDirectory, existingBlobs)
    .then(function() {
        return globby([
            '**',
            '!node_modules/**',
            '!Tools/**',
            '!.git*',
            '!.git/**'
        ], {
            dot : true, // include hidden files
            nodir : true // only directory files
        });
    }).then(function(files) {
        return Promise.map(files, function(file) {
            var blobName = uploadDirectory + '/' + file;
            var mimeLookup = getMimeType(blobName);
            var contentType = mimeLookup.type;
            var compress = mimeLookup.compress;
            var contentEncoding = compress ? 'gzip' : undefined;
            var contents;
            var etag;

            totalFiles++;

            return readFile(file)
                .then(function(content) {
                    if (compress) {
                        return gzip(content).then(function(result) {
                            contents = result;
                        });
                    } else {
                        contents = content;
                    }
                })
                .then(function() {
                    // compute hash and etag
                    var hash = crypto.createHash('md5').update(contents).digest('hex');
                    etag = crypto.createHash('md5').update(contents).digest('base64');

                    var index = existingBlobs.indexOf(blobName);
                    if (index > -1) {
                        // remove files ad we find them on disk
                        existingBlobs.splice(index, 1);

                        // get file info
                        return s3.headObject({
                            Bucket : bucketName,
                            Key : blobName}).promise()
                        .then(function(request) {
                            var data = request.data;
                            if (data.ETag === ('"' + hash + '"') &&
                                data.CacheControl === cacheControl &&
                                data.ContentType === contentType &&
                                data.ContentEncoding === contentEncoding) {
                                // We don't need to upload this file again
                                skipped++;
                                return false;
                            }
                            return true;
                        });
                    } else {
                        return true;
                    }
                })
                .then(function(upload) {
                    if (upload) {
                        console.log('Uploading ' + blobName + '...');
                        var params = {
                            Bucket : bucketName,
                            Key : blobName,
                            Body : contents,
                            ContentMD5 : etag,
                            ContentType : contentType,
                            ContentEncoding : contentEncoding,
                            CacheControl : cacheControl
                        };

                        return s3.putObject(params).promise().then(function(request) {
                            uploaded++;
                        },
                        function(error) {
                            console.log(error);
                        });
                    }
                });
        }, {concurrency : concurrencyLimit});
    })
    .then(function() {
        console.log('Skipped ' + skipped + ' files and successfully uploaded ' + uploaded + ' files of ' + (totalFiles - skipped) + ' files.');
        if (existingBlobs.length > 0) {
            console.log('Cleaning up old files...');
            return cleanFiles(s3, bucketName, existingBlobs).then(function() {
                console.log('Cleaned ' + existingBlobs.length + ' files.');
            });
        }
    });
}

function getMimeType(filename) {
    var ext = path.extname(filename);
    if (ext === '.bin' || ext === '.terrain') {
        return { type : 'application/octet-stream', compress : true };
    } else if (ext === '.md' || ext === '.glsl') {
        return { type : 'text/plain', compress : true };
    } else if (ext === '.czml' || ext === '.geojson' || ext === '.json') {
        return { type : 'application/json', compress : true };
    } else if (ext === '.js') {
        return { type : 'application/javascript', compress : true };
    } else if (ext === '.svg') {
        return { type : 'image/svg+xml', compress : true };
    } else if (ext === '.woff') {
        return { type : 'application/font-woff', compress : false };
    }

    var mimeType = mime.lookup(filename);
    return {type : mimeType, compress : compressible(mimeType)};
}

// get all files currently in bucket asynchronously
function listAll(s3, bucketName, directory, files, marker) {
    return s3.listObjects({
        Bucket : bucketName,
        MaxKeys : 1000,
        Prefix: directory,
        Marker : marker
    }).promise()
    .then(function(request) {
        var items = request.data.Contents;
        for (var i = 0; i < items.length; i++) {
            files.push(items[i].Key);
        }

        if (request.data.IsTruncated) {
            // get next page of results
            return listAll(s3, bucketName, directory, files, files[files.length - 1]);
        }
    },
    function(error) {
        console.log(error);
    });
}

// delete unneeded files in bucket asynchronously
function cleanFiles(s3, bucketName, files) {
    var params = {
        Bucket: bucketName,
        Delete: {
            Objects: []
        }
    };

    for (var i = 0; i < files.length; i++) {
        var blob = files[i];
        params.Delete.Objects.push({Key: blob});
    }

    return s3.deleteObjects(params).promise();
}

gulp.task('release', ['combine', 'minifyRelease', 'generateDocumentation']);

gulp.task('test', function(done) {
    var argv = yargs.argv;

    var enableAllBrowsers = argv.all ? true : false;
    var includeCategory = argv.include ? argv.include : '';
    var excludeCategory = argv.exclude ? argv.exclude : '';
    var webglValidation = argv.webglValidation ? argv.webglValidation : false;
    var release = argv.release ? argv.release : false;
    var failTaskOnError = argv.failTaskOnError ? argv.failTaskOnError : false;
    var suppressPassed = argv.suppressPassed ? argv.suppressPassed : false;

    var browsers;
    if (argv.browsers) {
        browsers = argv.browsers.split(',');
    }

    var files = [
        'Specs/karma-main.js',
        {pattern : 'Source/**', included : false},
        {pattern : 'Specs/**', included : false}
    ];

    if (release) {
        files.push({pattern : 'Build/**', included : false});
    }

    karma.start({
        configFile: karmaConfigFile,
        browsers : browsers,
        specReporter: {
            suppressErrorSummary: false,
            suppressFailed: false,
            suppressPassed: suppressPassed,
            suppressSkipped: true
        },
        detectBrowsers : {
            enabled: enableAllBrowsers
        },
        files: files,
        client: {
            args: [includeCategory, excludeCategory, webglValidation, release]
        }
    }, function(e) {
        return done(failTaskOnError ? e : undefined);
    });
});

gulp.task('generateStubs', ['build'], function(done) {
    mkdirp.sync(path.join('Build', 'Stubs'));

    var contents = '\
/*global define,Cesium*/\n\
(function() {\n\
\'use strict\';\n\
/*jshint sub:true*/\n';
    var modulePathMappings = [];

    globby.sync(sourceFiles).forEach(function(file) {
        file = path.relative('Source', file);
        var moduleId = filePathToModuleId(file);

        contents += '\
define(\'' + moduleId + '\', function() {\n\
    return Cesium[\'' + path.basename(file, path.extname(file)) + '\'];\n\
});\n\n';

        modulePathMappings.push('        \'' + moduleId + '\' : \'../Stubs/Cesium\'');
    });

    contents += '})();';

    var paths = '\
/*global define*/\n\
define(function() {\n\
    \'use strict\';\n\
    return {\n' + modulePathMappings.join(',\n') + '\n\
    };\n\
});';

    fs.writeFileSync(path.join('Build', 'Stubs', 'Cesium.js'), contents);
    fs.writeFileSync(path.join('Build', 'Stubs', 'paths.js'), paths);
    done();
});

gulp.task('sortRequires', function(done) {
    var noModulesRegex = /[\s\S]*?define\(function\(\)/;
    var requiresRegex = /([\s\S]*?(define|defineSuite|require)\((?:{[\s\S]*}, )?\[)([\S\s]*?)]([\s\S]*?function\s*)\(([\S\s]*?)\) {([\s\S]*)/;
    var splitRegex = /,\s*/;
    var filesChecked = 0;

    var files = globby.sync(filesToSortRequires);
    async.forEach(files, function(file, callback) {
        if (filesChecked > 0 && filesChecked % 50 === 0) {
            console.log('Sorted requires in ' + filesChecked + ' files');
        }
        ++filesChecked;

        fs.readFile(file, function(err, contents) {
            if (err) {
                return callback(err);
            }

            var result = requiresRegex.exec(contents);

            if (result === null) {
                if (!noModulesRegex.test(contents)) {
                    console.log(file + ' does not have the expected syntax.');
                }
                return;
            }

            // In specs, the first require is significant,
            // unless the spec is given an explicit name.
            var preserveFirst = false;
            if (result[2] === 'defineSuite' && result[4] === ', function') {
                preserveFirst = true;
            }

            var names = result[3].split(splitRegex);
            if (names.length === 1 && names[0].trim() === '') {
                names.length = 0;
            }

            var i;
            for (i = 0; i < names.length; ++i) {
                if (names[i].indexOf('//') >= 0 || names[i].indexOf('/*') >= 0) {
                    console.log(file + ' contains comments in the require list.  Skipping so nothing gets broken.');
                    return;
                }
            }

            var identifiers = result[5].split(splitRegex);
            if (identifiers.length === 1 && identifiers[0].trim() === '') {
                identifiers.length = 0;
            }

            for (i = 0; i < identifiers.length; ++i) {
                if (identifiers[i].indexOf('//') >= 0 || identifiers[i].indexOf('/*') >= 0) {
                    console.log(file + ' contains comments in the require list.  Skipping so nothing gets broken.');
                    return;
                }
            }

            var requires = [];

            for (i = preserveFirst ? 1 : 0; i < names.length && i < identifiers.length; ++i) {
                requires.push({
                    name : names[i].trim(),
                    identifier : identifiers[i].trim()
                });
            }

            requires.sort(function(a, b) {
                var aName = a.name.toLowerCase();
                var bName = b.name.toLowerCase();
                if (aName < bName) {
                    return -1;
                } else if (aName > bName) {
                    return 1;
                } else {
                    return 0;
                }
            });

            if (preserveFirst) {
                requires.splice(0, 0, {
                    name : names[0].trim(),
                    identifier : identifiers[0].trim()
                });
            }

            // Convert back to separate lists for the names and identifiers, and add
            // any additional names or identifiers that don't have a corresponding pair.
            var sortedNames = requires.map(function(item) {
                return item.name;
            });
            for (i = sortedNames.length; i < names.length; ++i) {
                sortedNames.push(names[i].trim());
            }

            var sortedIdentifiers = requires.map(function(item) {
                return item.identifier;
            });
            for (i = sortedIdentifiers.length; i < identifiers.length; ++i) {
                sortedIdentifiers.push(identifiers[i].trim());
            }

            var outputNames = ']';
            if (sortedNames.length > 0) {
                outputNames = '\r\n        ' +
                              sortedNames.join(',\r\n        ') +
                              '\r\n    ]';
            }

            var outputIdentifiers = '(';
            if (sortedIdentifiers.length > 0) {
                outputIdentifiers = '(\r\n        ' +
                                    sortedIdentifiers.join(',\r\n        ');
            }

            contents = result[1] +
                       outputNames +
                       result[4].replace(/^[,\s]+/, ', ').trim() +
                       outputIdentifiers +
                       ') {' +
                       result[6];

            fs.writeFile(file, contents, callback);
        });
    }, done);
});

function combineCesium(debug, optimizer, combineOutput) {
    return requirejsOptimize('Cesium.js', {
        wrap : true,
        useStrict : true,
        optimize : optimizer,
        optimizeCss : 'standard',
        pragmas : {
            debug : debug
        },
        baseUrl : 'Source',
        skipModuleInsertion : true,
        name : removeExtension(path.relative('Source', require.resolve('almond'))),
        include : 'main',
        out : path.join(combineOutput, 'Cesium.js')
    });
}

function combineWorkers(debug, optimizer, combineOutput) {
    //This is done waterfall style for concurrency reasons.
    return globby(['Source/Workers/cesiumWorkerBootstrapper.js',
                   'Source/Workers/transferTypedArrayTest.js',
                   'Source/ThirdParty/Workers/*.js'])
        .then(function(files) {
            return Promise.map(files, function(file) {
                return requirejsOptimize(file, {
                    wrap : false,
                    useStrict : true,
                    optimize : optimizer,
                    optimizeCss : 'standard',
                    pragmas : {
                        debug : debug
                    },
                    baseUrl : 'Source',
                    skipModuleInsertion : true,
                    include : filePathToModuleId(path.relative('Source', file)),
                    out : path.join(combineOutput, path.relative('Source', file))
                });
            }, {concurrency : concurrency});
        })
        .then(function() {
            return globby(['Source/Workers/*.js',
                           '!Source/Workers/cesiumWorkerBootstrapper.js',
                           '!Source/Workers/transferTypedArrayTest.js',
                           '!Source/Workers/createTaskProcessorWorker.js',
                           '!Source/ThirdParty/Workers/*.js']);
        })
        .then(function(files) {
            return Promise.map(files, function(file) {
                return requirejsOptimize(file, {
                    wrap : true,
                    useStrict : true,
                    optimize : optimizer,
                    optimizeCss : 'standard',
                    pragmas : {
                        debug : debug
                    },
                    baseUrl : 'Source',
                    include : filePathToModuleId(path.relative('Source', file)),
                    out : path.join(combineOutput, path.relative('Source', file))
                });
            }, {concurrency : concurrency});
        });
}

function minifyCSS(outputDirectory) {
    return globby('Source/**/*.css').then(function(files) {
        return Promise.map(files, function(file) {
            return requirejsOptimize(file, {
                wrap : true,
                useStrict : true,
                optimizeCss : 'standard',
                pragmas : {
                    debug : true
                },
                cssIn : file,
                out : path.join(outputDirectory, path.relative('Source', file))
            });
        }, {concurrency : concurrency});
    });
}

function combineJavaScript(options) {
    var optimizer = options.optimizer;
    var outputDirectory = options.outputDirectory;
    var removePragmas = options.removePragmas;

    var combineOutput = path.join('Build', 'combineOutput', optimizer);
    var copyrightHeader = fs.readFileSync(path.join('Source', 'copyrightHeader.js'));

    var promise = Promise.join(
        combineCesium(!removePragmas, optimizer, combineOutput),
        combineWorkers(!removePragmas, optimizer, combineOutput)
    );

    return promise.then(function() {
        var promises = [];

        //copy to build folder with copyright header added at the top
        var stream = gulp.src([combineOutput + '/**'])
            .pipe(gulpInsert.prepend(copyrightHeader))
            .pipe(gulp.dest(outputDirectory));

        promises.push(streamToPromise(stream));

        var everythingElse = ['Source/**', '!**/*.js', '!**/*.glsl'];

        if (optimizer === 'uglify2') {
            promises.push(minifyCSS(outputDirectory));
            everythingElse.push('!**/*.css');
        }

        stream = gulp.src(everythingElse, {nodir : true}).pipe(gulp.dest(outputDirectory));
        promises.push(streamToPromise(stream));

        return Promise.all(promises).then(function() {
            rimraf.sync(combineOutput);
        });
    });
}

function glslToJavaScript(minify, minifyStateFilePath) {
    fs.writeFileSync(minifyStateFilePath, minify);
    var minifyStateFileLastModified = fs.existsSync(minifyStateFilePath) ? fs.statSync(minifyStateFilePath).mtime.getTime() : 0;

// collect all currently existing JS files into a set, later we will remove the ones
// we still are using from the set, then delete any files remaining in the set.
    var leftOverJsFiles = {};

    globby.sync(['Source/Shaders/**/*.js']).forEach(function(file) {
        leftOverJsFiles[path.normalize(file)] = true;
    });

    var builtinFunctions = [];
    var builtinConstants = [];
    var builtinStructs = [];

    var glslFiles = globby.sync(['Source/Shaders/**/*.glsl']);
    glslFiles.forEach(function(glslFile) {
        glslFile = path.normalize(glslFile);
        var baseName = path.basename(glslFile, '.glsl');
        var jsFile = path.join(path.dirname(glslFile), baseName) + '.js';

        // identify built in functions, structs, and constants
        var baseDir = path.join('Source', 'Shaders', 'Builtin');
        if (glslFile.indexOf(path.normalize(path.join(baseDir, 'Functions'))) === 0) {
            builtinFunctions.push(baseName);
        }
        else if (glslFile.indexOf(path.normalize(path.join(baseDir, 'Constants'))) === 0) {
            builtinConstants.push(baseName);
        }
        else if (glslFile.indexOf(path.normalize(path.join(baseDir, 'Structs'))) === 0) {
            builtinStructs.push(baseName);
        }

        delete leftOverJsFiles[jsFile];

        var jsFileExists = fs.existsSync(jsFile);
        var jsFileModified = jsFileExists ? fs.statSync(jsFile).mtime.getTime() : 0;
        var glslFileModified = fs.statSync(glslFile).mtime.getTime();

        if (jsFileExists && jsFileModified > glslFileModified && jsFileModified > minifyStateFileLastModified) {
            return;
        }

        var contents = fs.readFileSync(glslFile, 'utf8');
        contents = contents.replace(/\r\n/gm, '\n');

        var copyrightComments = '';
        var extractedCopyrightComments = contents.match(/\/\*\*(?:[^*\/]|\*(?!\/)|\n)*?@license(?:.|\n)*?\*\//gm);
        if (extractedCopyrightComments) {
            copyrightComments = extractedCopyrightComments.join('\n') + '\n';
        }

        if (minify) {
            contents = stripComments(contents);
            contents = contents.replace(/\s+$/gm, '').replace(/^\s+/gm, '').replace(/\n+/gm, '\n');
            contents += '\n';
        }

        contents = contents.split('"').join('\\"').replace(/\n/gm, '\\n\\\n');
        contents = copyrightComments + '\
//This file is automatically rebuilt by the Cesium build process.\n\
/*global define*/\n\
define(function() {\n\
    \'use strict\';\n\
    return "' + contents + '";\n\
});';

        fs.writeFileSync(jsFile, contents);
    });

    // delete any left over JS files from old shaders
    Object.keys(leftOverJsFiles).forEach(function(filepath) {
        rimraf.sync(filepath);
    });

    var generateBuiltinContents = function(contents, builtins, path) {
        var amdPath = contents.amdPath;
        var amdClassName = contents.amdClassName;
        var builtinLookup = contents.builtinLookup;
        for (var i = 0; i < builtins.length; i++) {
            var builtin = builtins[i];
            amdPath = amdPath + ',\n        \'./' + path + '/' + builtin + '\'';
            amdClassName = amdClassName + ',\n        ' + 'czm_' + builtin;
            builtinLookup = builtinLookup + ',\n        ' + 'czm_' + builtin + ' : ' + 'czm_' + builtin;
        }
        contents.amdPath = amdPath;
        contents.amdClassName = amdClassName;
        contents.builtinLookup = builtinLookup;
    };

//generate the JS file for Built-in GLSL Functions, Structs, and Constants
    var contents = {amdPath : '', amdClassName : '', builtinLookup : ''};
    generateBuiltinContents(contents, builtinConstants, 'Constants');
    generateBuiltinContents(contents, builtinStructs, 'Structs');
    generateBuiltinContents(contents, builtinFunctions, 'Functions');

    contents.amdPath = contents.amdPath.replace(',\n', '');
    contents.amdClassName = contents.amdClassName.replace(',\n', '');
    contents.builtinLookup = contents.builtinLookup.replace(',\n', '');

    var fileContents = '\
//This file is automatically rebuilt by the Cesium build process.\n\
/*global define*/\n\
define([\n' +
                       contents.amdPath +
                       '\n    ], function(\n' +
                       contents.amdClassName +
                       ') {\n\
                           \'use strict\';\n\
                           return {\n' + contents.builtinLookup + '};\n\
});';

    fs.writeFileSync(path.join('Source', 'Shaders', 'Builtin', 'CzmBuiltins.js'), fileContents);
}

function createCesiumJs() {
    var moduleIds = [];
    var parameters = [];
    var assignments = [];

    var nonIdentifierRegexp = /[^0-9a-zA-Z_$]/g;

    globby.sync(sourceFiles).forEach(function(file) {
        file = path.relative('Source', file);
        var moduleId = file;
        moduleId = filePathToModuleId(moduleId);

        var assignmentName = "['" + path.basename(file, path.extname(file)) + "']";
        if (moduleId.indexOf('Shaders/') === 0) {
            assignmentName = '._shaders' + assignmentName;
        }

        var parameterName = moduleId.replace(nonIdentifierRegexp, '_');

        moduleIds.push("'./" + moduleId + "'");
        parameters.push(parameterName);
        assignments.push('Cesium' + assignmentName + ' = ' + parameterName + ';');
    });

    var contents = '\
/*global define*/\n\
define([' + moduleIds.join(', ') + '], function(' + parameters.join(', ') + ') {\n\
  \'use strict\';\n\
  /*jshint sub:true*/\n\
  var Cesium = {\n\
    VERSION : "' + version + '",\n\
    _shaders : {}\n\
  };\n\
  ' + assignments.join('\n  ') + '\n\
  return Cesium;\n\
});';

    fs.writeFileSync('Source/Cesium.js', contents);
}

function createSpecList() {
    var specFiles = globby.sync(['Specs/**/*.js', '!Specs/*.js']);
    var specs = [];

    specFiles.forEach(function(file) {
        specs.push("'" + filePathToModuleId(file) + "'");
    });

    var contents = '/*jshint unused: false*/\nvar specs = [' + specs.join(',') + '];';
    fs.writeFileSync(path.join('Specs', 'SpecList.js'), contents);
}

function createGalleryList() {
    var demos = [];
    var output = path.join('Apps', 'Sandcastle', 'gallery', 'gallery-index.js');

    var fileList = ['Apps/Sandcastle/gallery/**/*.html'];
    if (noDevelopmentGallery) {
        fileList.push('!Apps/Sandcastle/gallery/development/**/*.html');
    }

    globby.sync(fileList).forEach(function(file) {
        var demo = filePathToModuleId(path.relative('Apps/Sandcastle/gallery', file));
        var demoObject = {
            name : demo,
            date : fs.statSync(file).mtime.getTime()
        };

        if (fs.existsSync(file.replace('.html', '') + '.jpg')) {
            demoObject.img = demo + '.jpg';
        }

        demos.push(JSON.stringify(demoObject, null, 2));
    });

    var contents = '\
// This file is automatically rebuilt by the Cesium build process.\n\
var gallery_demos = [' + demos.join(', ') + '];';

    fs.writeFileSync(output, contents);
}

function createJsHintOptions() {
    var primary = JSON.parse(fs.readFileSync('.jshintrc', 'utf8'));
    var gallery = JSON.parse(fs.readFileSync(path.join('Apps', 'Sandcastle', '.jshintrc'), 'utf8'));
    primary.jasmine = false;
    primary.predef = gallery.predef;
    primary.unused = gallery.unused;

    var contents = '\
// This file is automatically rebuilt by the Cesium build process.\n\
var sandcastleJsHintOptions = ' + JSON.stringify(primary, null, 4) + ';';

    fs.writeFileSync(path.join('Apps', 'Sandcastle', 'jsHintOptions.js'), contents);
}

function buildCesiumViewer() {
    var cesiumViewerOutputDirectory = 'Build/Apps/CesiumViewer';
    var cesiumViewerStartup = path.join(cesiumViewerOutputDirectory, 'CesiumViewerStartup.js');
    var cesiumViewerCss = path.join(cesiumViewerOutputDirectory, 'CesiumViewer.css');
    mkdirp.sync(cesiumViewerOutputDirectory);

    var promise = Promise.join(
        requirejsOptimize('CesiumViewer', {
            wrap : true,
            useStrict : true,
            optimizeCss : 'standard',
            pragmas : {
                debug : false
            },
            optimize : 'uglify2',
            mainConfigFile : 'Apps/CesiumViewer/CesiumViewerStartup.js',
            name : 'CesiumViewerStartup',
            out : cesiumViewerStartup
        }),
        requirejsOptimize('CesiumViewer CSS', {
            wrap : true,
            useStrict : true,
            optimizeCss : 'standard',
            pragmas : {
                debug : false
            },
            cssIn : 'Apps/CesiumViewer/CesiumViewer.css',
            out : cesiumViewerCss
        })
    );

    promise = promise.then(function() {
        var copyrightHeader = fs.readFileSync(path.join('Source', 'copyrightHeader.js'));

        var stream = eventStream.merge(
            gulp.src(cesiumViewerStartup)
                .pipe(gulpInsert.prepend(copyrightHeader))
                .pipe(gulpReplace('../../Source', '.'))
                .pipe(gulpReplace('../../ThirdParty/requirejs-2.1.20', '.')),

            gulp.src(cesiumViewerCss)
                .pipe(gulpReplace('../../Source', '.')),

            gulp.src(['Apps/CesiumViewer/index.html'])
                .pipe(gulpReplace('../../ThirdParty/requirejs-2.1.20', '.')),

            gulp.src(['Apps/CesiumViewer/**',
                      '!Apps/CesiumViewer/index.html',
                      '!Apps/CesiumViewer/**/*.js',
                      '!Apps/CesiumViewer/**/*.css']),

            gulp.src(['ThirdParty/requirejs-2.1.20/require.min.js'])
                .pipe(gulpRename('require.js')),

            gulp.src(['Build/Cesium/Assets/**',
                      'Build/Cesium/Workers/**',
                      'Build/Cesium/ThirdParty/Workers/**',
                      'Build/Cesium/Widgets/**',
                      '!Build/Cesium/Widgets/**/*.css'],
                {
                    base : 'Build/Cesium',
                    nodir : true
                }),

            gulp.src(['Build/Cesium/Widgets/InfoBox/InfoBoxDescription.css'], {
                base : 'Build/Cesium'
            }),

            gulp.src(['web.config'])
        );

        return streamToPromise(stream.pipe(gulp.dest(cesiumViewerOutputDirectory)));
    });

    return promise;
}

function filePathToModuleId(moduleId) {
    return moduleId.substring(0, moduleId.lastIndexOf('.')).replace(/\\/g, '/');
}

function removeExtension(p) {
    return p.slice(0, -path.extname(p).length);
}

function requirejsOptimize(name, config) {
    console.log('Building ' + name);
    return new Promise(function(resolve, reject) {
        var cmd = 'npm run requirejs -- --' + new Buffer(JSON.stringify(config)).toString('base64') + ' --silent';
        child_process.exec(cmd, function(e) {
            if (e) {
                console.log('Error ' + name);
                reject(e);
                return;
            }
            console.log('Finished ' + name);
            resolve();
        });
    });
}

function streamToPromise(stream) {
    return new Promise(function(resolve, reject) {
        stream.on('finish', resolve);
        stream.on('end', reject);
    });
}
