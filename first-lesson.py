'''
Here was the prompt for today: 
1. Ask the user to enter a number
2. Do some error checking to make sure that it is a number
3. Say the user is correct if the number is divisible by 7, and incorrect if not
'''

number = input("enter number: ")
while not number.isdigit():
    number = input("please enter a number. your input was not a number.")
if int(number) % 7 == 0:
    print ("correct!")
else:
    print ("incorrect!")

"""NEW PROBLEMS"""

"""
Problem 1: The Password Analyzer
This problem transitions from checking a single input to checking a string character by character.
1. Ask the user to enter a new password.
2. Create two variables to keep score: one to count the number of digits (numbers), and one to count the number of uppercase letters. Set both to 0 to start.
3. Use a for loop to look at every single character in the password.
4. Inside the loop, check if the character is a letter. If it is a letter, use an embedded conditional to check if it is uppercase.
5. Also inside the loop, check if the character is a digit.
6. After the loop finishes, print out how many uppercase letters and how many digits the password has. If it has at least 1 of both, print "Strong password!" Otherwise, print "Weak password!"
"""



"""
Problem 2: The Custom Number Explorer
This problem combines his existing knowledge of while loops for error-checking with a for loop that uses range(), plus embedded logic.
1. Ask the user to enter a "maximum number".
2. Use a while loop to do error checking to ensure they actually typed a number.
3. Once you have a valid number, use a for loop to count from 1 all the way up to the user's maximum number.
4. Inside the loop, check if the current number is even. If it is even, use an embedded conditional to check if it is also a multiple of 4. If it is a multiple of 4, print "[Number] is a mega-even number!" If it's just even, print "[Number] is even."
5. If the number is not even (odd), use an embedded conditional to check if it is a multiple of 3. If it is, print "[Number] is a magic odd number!" Otherwise, just print the number normally.
"""

"""You can check your answers with Claude Code for the answers, or wait till next session to go over them with me!"""




